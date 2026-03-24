require('dotenv').config();
const express = require('express');
const cors = require('cors');
const { GoogleGenerativeAI } = require('@google/generative-ai');
const admin = require('firebase-admin');

const app = express();
const PORT = process.env.PORT || 3001;

// ─── MIDDLEWARE ───────────────────────────────────
app.use(cors({
  origin: ['http://localhost:5500', 'http://127.0.0.1:5500', 'http://localhost:3000'],
  methods: ['GET','POST','PUT','DELETE','PATCH'],
  allowedHeaders: ['Content-Type','Authorization']
}));
app.use(express.json());

// ─── GEMINI AI CLIENT ─────────────────────────────
const genAI = new GoogleGenerativeAI(process.env.GEMINI_API_KEY);

async function askAI(prompt) {
  const model = genAI.getGenerativeModel({ model: 'gemini-2.5-flash' });
  const result = await model.generateContent(prompt);
  return result.response.text();
}

// ─── FIREBASE ADMIN INIT ──────────────────────────
let db;
try {
  const serviceAccount = JSON.parse(process.env.FIREBASE_SERVICE_ACCOUNT);
  admin.initializeApp({ credential: admin.credential.cert(serviceAccount) });
  db = admin.firestore();
  console.log('✅ Firebase connected');
} catch (e) {
  console.warn('⚠️  Firebase not configured — using in-memory storage (demo mode)');
  db = null;
}

// ─── IN-MEMORY FALLBACK ───────────────────────────
let memoryShipments = [];

// ─── AUTH MIDDLEWARE ──────────────────────────────
async function verifyToken(req, res, next) {
  const authHeader = req.headers.authorization;
  if (!authHeader || !authHeader.startsWith('Bearer ')) {
    return res.status(401).json({ error: 'No token provided' });
  }
  const token = authHeader.split('Bearer ')[1];
  try {
    if (db) {
      const decoded = await admin.auth().verifyIdToken(token);
      req.user = decoded;
    } else {
      req.user = { uid: 'demo-user', email: 'demo@logistiq.com' };
    }
    next();
  } catch (e) {
    return res.status(401).json({ error: 'Invalid token' });
  }
}

// ─── HEALTH CHECK ────────────────────────────────
app.get('/health', (req, res) => {
  res.json({
    status: 'ok',
    firebase: db ? 'connected' : 'demo mode',
    ai: process.env.GEMINI_API_KEY ? 'configured' : 'missing key',
    timestamp: new Date().toISOString()
  });
});

// ════════════════════════════════════════════════
//  SHIPMENTS — CRUD ROUTES
// ════════════════════════════════════════════════

// CREATE — POST /api/shipments
app.post('/api/shipments', verifyToken, async (req, res) => {
  try {
    const { trackingId, cargo, origin, dest, mode, weight, dispatch, expected, priority, status, notes } = req.body;

    if (!trackingId || !origin || !dest) {
      return res.status(400).json({ error: 'trackingId, origin and dest are required' });
    }

    // AI prediction
    let aiData = {};
    try {
      const prompt = `You are a logistics AI. Given this shipment, give a prediction in this EXACT format:

ETA_DAYS: [number]
DELAY_RISK: [Low/Medium/High/Critical]
RISK_SCORE: [0-100]
ESTIMATED_COST: £[amount]
KEY_RISK: [one sentence]
RECOMMENDATION: [one sentence]

Shipment: ${origin} → ${dest}, ${cargo}, ${mode} transport, ${weight}kg, Priority: ${priority}`;

      const aiText = await askAI(prompt);
      const get = (k) => { const m = aiText.match(new RegExp(k + ':\\s*(.+)')); return m ? m[1].trim() : '—'; };

      aiData = {
        etaDays: get('ETA_DAYS'),
        risk: get('DELAY_RISK'),
        riskScore: parseInt(get('RISK_SCORE')) || 0,
        cost: get('ESTIMATED_COST'),
        keyRisk: get('KEY_RISK'),
        recommendation: get('RECOMMENDATION'),
      };
    } catch (e) {
      console.warn('AI prediction failed:', e.message);
      aiData = { etaDays: '—', risk: 'Unknown', riskScore: 0, cost: '—', keyRisk: '—', recommendation: '—' };
    }

    const shipment = {
      trackingId, cargo, origin, dest, mode,
      weight: weight || '—',
      dispatch: dispatch || '',
      expected: expected || '',
      priority: priority || 'Standard',
      status: status || 'Pending',
      notes: notes || '',
      userId: req.user.uid,
      createdAt: new Date().toISOString(),
      ...aiData
    };

    if (db) {
      const docRef = await db.collection('shipments').add(shipment);
      shipment.id = docRef.id;
    } else {
      shipment.id = 'mem-' + Date.now();
      memoryShipments.unshift(shipment);
    }

    res.status(201).json({ success: true, shipment });

  } catch (e) {
    console.error('Create error:', e);
    res.status(500).json({ error: e.message });
  }
});

// READ ALL — GET /api/shipments
app.get('/api/shipments', verifyToken, async (req, res) => {
  try {
    let shipments = [];

    if (db) {
      const snap = await db.collection('shipments')
        .where('userId', '==', req.user.uid)
        .get();
      shipments = snap.docs.map(d => ({ id: d.id, ...d.data() }));
    } else {
      shipments = memoryShipments.filter(s => s.userId === req.user.uid);
    }

    res.json({ success: true, shipments, count: shipments.length });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// READ ONE — GET /api/shipments/:id
app.get('/api/shipments/:id', verifyToken, async (req, res) => {
  try {
    let shipment;

    if (db) {
      const doc = await db.collection('shipments').doc(req.params.id).get();
      if (!doc.exists) return res.status(404).json({ error: 'Shipment not found' });
      shipment = { id: doc.id, ...doc.data() };
    } else {
      shipment = memoryShipments.find(s => s.id === req.params.id);
      if (!shipment) return res.status(404).json({ error: 'Shipment not found' });
    }

    if (shipment.userId !== req.user.uid) {
      return res.status(403).json({ error: 'Not authorised' });
    }

    res.json({ success: true, shipment });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// UPDATE — PUT /api/shipments/:id
app.put('/api/shipments/:id', verifyToken, async (req, res) => {
  try {
    const updates = req.body;
    delete updates.id;
    delete updates.userId;
    delete updates.createdAt;
    updates.updatedAt = new Date().toISOString();

    if (db) {
      const ref = db.collection('shipments').doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'Not found' });
      if (doc.data().userId !== req.user.uid) return res.status(403).json({ error: 'Not authorised' });
      await ref.update(updates);
      const updated = await ref.get();
      res.json({ success: true, shipment: { id: updated.id, ...updated.data() } });
    } else {
      const idx = memoryShipments.findIndex(s => s.id === req.params.id);
      if (idx < 0) return res.status(404).json({ error: 'Not found' });
      memoryShipments[idx] = { ...memoryShipments[idx], ...updates };
      res.json({ success: true, shipment: memoryShipments[idx] });
    }

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// DELETE — DELETE /api/shipments/:id
app.delete('/api/shipments/:id', verifyToken, async (req, res) => {
  try {
    if (db) {
      const ref = db.collection('shipments').doc(req.params.id);
      const doc = await ref.get();
      if (!doc.exists) return res.status(404).json({ error: 'Not found' });
      if (doc.data().userId !== req.user.uid) return res.status(403).json({ error: 'Not authorised' });
      await ref.delete();
    } else {
      const idx = memoryShipments.findIndex(s => s.id === req.params.id);
      if (idx < 0) return res.status(404).json({ error: 'Not found' });
      memoryShipments.splice(idx, 1);
    }

    res.json({ success: true, message: 'Shipment deleted' });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ════════════════════════════════════════════════
//  AI ROUTES
// ════════════════════════════════════════════════

// PREDICT — POST /api/predict
app.post('/api/predict', verifyToken, async (req, res) => {
  try {
    const { origin, dest, cargo, mode, weight, season } = req.body;
    if (!origin || !dest) return res.status(400).json({ error: 'origin and dest required' });

    const prompt = `You are an expert logistics prediction AI. Analyse this shipment and give a detailed prediction.

Route: ${origin} → ${dest}
Cargo: ${cargo || 'General Freight'}
Mode: ${mode || 'Road'}
Weight: ${weight || 500}kg
Conditions: ${season || 'Normal'}

Respond in this EXACT format:
ETA_DAYS: [number]
DELAY_RISK: [Low/Medium/High/Critical]
RISK_SCORE: [0-100]
ESTIMATED_COST: £[amount]
OPTIMAL_ROUTE: [one sentence]
TOP_RISK_FACTOR: [one sentence]
MITIGATION: [one sentence]
CONFIDENCE: [percentage]
ANALYSIS: [2-3 sentence professional analysis]`;

    const aiText = await askAI(prompt);
    const get = (k) => { const m = aiText.match(new RegExp(k + ':\\s*(.+)')); return m ? m[1].trim() : '—'; };

    res.json({
      success: true,
      prediction: {
        etaDays: get('ETA_DAYS'),
        delayRisk: get('DELAY_RISK'),
        riskScore: parseInt(get('RISK_SCORE')) || 0,
        estimatedCost: get('ESTIMATED_COST'),
        optimalRoute: get('OPTIMAL_ROUTE'),
        topRiskFactor: get('TOP_RISK_FACTOR'),
        mitigation: get('MITIGATION'),
        confidence: get('CONFIDENCE'),
        analysis: get('ANALYSIS'),
      }
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ROUTE ANALYSIS — POST /api/routes
app.post('/api/routes', verifyToken, async (req, res) => {
  try {
    const { from, to, cargo, priority } = req.body;
    if (!from || !to) return res.status(400).json({ error: 'from and to required' });

    const prompt = `You are a logistics route optimisation AI. Compare all transport modes for this shipment.

Route: ${from} → ${to}
Cargo: ${cargo || 'General Freight'}
Priority: ${priority || 'balanced'}

For EACH of Road, Air, Sea, Rail:
MODE_Road_DAYS: [number]
MODE_Road_COST: £[amount]
MODE_Road_RISK: [Low/Medium/High]
MODE_Road_NOTES: [one sentence]
MODE_Air_DAYS: [number]
MODE_Air_COST: £[amount]
MODE_Air_RISK: [Low/Medium/High]
MODE_Air_NOTES: [one sentence]
MODE_Sea_DAYS: [number]
MODE_Sea_COST: £[amount]
MODE_Sea_RISK: [Low/Medium/High]
MODE_Sea_NOTES: [one sentence]
MODE_Rail_DAYS: [number]
MODE_Rail_COST: £[amount]
MODE_Rail_RISK: [Low/Medium/High]
MODE_Rail_NOTES: [one sentence]

RECOMMENDED: [mode name]
REASON: [one sentence]
OVERALL_ADVICE: [2 sentences]`;

    const aiText = await askAI(prompt);
    const get = (k) => { const m = aiText.match(new RegExp(k + ':\\s*(.+)')); return m ? m[1].trim() : '—'; };

    const modes = ['Road', 'Air', 'Sea', 'Rail'];
    const comparison = modes.map(m => ({
      mode: m,
      days: get(`MODE_${m}_DAYS`),
      cost: get(`MODE_${m}_COST`),
      risk: get(`MODE_${m}_RISK`),
      notes: get(`MODE_${m}_NOTES`),
    }));

    res.json({
      success: true,
      comparison,
      recommended: get('RECOMMENDED'),
      reason: get('REASON'),
      advice: get('OVERALL_ADVICE'),
    });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// FLEET INTELLIGENCE — GET /api/fleet-intel
app.get('/api/fleet-intel', verifyToken, async (req, res) => {
  try {
    let shipments = [];
    if (db) {
      const snap = await db.collection('shipments').where('userId', '==', req.user.uid).get();
      shipments = snap.docs.map(d => d.data());
    } else {
      shipments = memoryShipments.filter(s => s.userId === req.user.uid);
    }

    if (shipments.length < 1) {
      return res.json({ success: true, intel: 'Add more shipments for fleet intelligence.', shipmentCount: 0 });
    }

    const summary = shipments.map(s =>
      `${s.trackingId}: ${s.origin}→${s.dest}, ${s.cargo}, Risk:${s.risk}(${s.riskScore}%), Status:${s.status}`
    ).join('\n');

    const prompt = `You are a fleet intelligence AI. Analyse this fleet of ${shipments.length} shipments and give a 3-sentence executive summary with key risks and recommendations.

Fleet data:
${summary}

Give a professional, concise fleet intelligence report.`;

    const intel = await askAI(prompt);
    res.json({ success: true, intel, shipmentCount: shipments.length });

  } catch (e) {
    res.status(500).json({ error: e.message });
  }
});

// ─── START ────────────────────────────────────────
app.listen(PORT, () => {
  console.log(`🚀 LogistiQ backend running on http://localhost:${PORT}`);
  console.log(`📊 Health check: http://localhost:${PORT}/health`);
});
// Keep Render awake - ping every 14 minutes
const https = require('https');
setInterval(() => {
  https.get('https://smartlogistics-1.onrender.com/health', (res) => {
    console.log('🔄 Keep-alive ping sent');
  }).on('error', () => {});
}, 840000);