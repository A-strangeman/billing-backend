// server.js - Optimized Version
import express from "express";
import session from "express-session";
import path from "path";
import cors from "cors";
import dotenv from "dotenv";
import { fileURLToPath } from "url";
import mysql from "mysql2/promise";
import compression from "compression";
import helmet from "helmet";
import rateLimit from "express-rate-limit";

/* ─────────────────────────────────────────────
   Setup & Environment
────────────────────────────────────────────── */
const __filename = fileURLToPath(import.meta.url);
const __dirname = path.dirname(__filename);

dotenv.config({ path: path.join(__dirname, ".env") });

const app = express();
const PORT = process.env.PORT || 4000;

/* ─────────────────────────────────────────────
   Enhanced MySQL Configuration with Connection Pooling
────────────────────────────────────────────── */
const db = mysql.createPool({
  host: process.env.DB_HOST,
  user: process.env.DB_USER,
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME,
  port: Number(process.env.DB_PORT) || 3306,
  waitForConnections: true,
  connectionLimit: 15, // Increased from 10
  queueLimit: 0,
  // Remove invalid options that cause warnings
  // acquireTimeout: 60000,  -- Not valid for mysql2
  // timeout: 60000,         -- Not valid for mysql2  
  // reconnect: true,        -- Not valid for mysql2
  charset: 'utf8mb4',
  timezone: '+00:00',
  // Valid performance optimizations for mysql2
  supportBigNumbers: true,
  bigNumberStrings: true,
  dateStrings: false,
  multipleStatements: false
});

// Health check with connection pooling info
app.get("/api/test-db", async (_req, res) => {
  try {
    const conn = await db.getConnection();
    await conn.ping(); 
    conn.release();
    
    // Pool status for monitoring
    const poolStatus = {
      totalConnections: db.pool._allConnections.length,
      freeConnections: db.pool._freeConnections.length,
      acquiringConnections: db.pool._acquiringConnections.length
    };
    
    res.json({ 
      ok: true, 
      message: "Cloud Clever DB connected!", 
      poolStatus 
    });
  } catch (err) {
    console.error("DB test failed:", err);
    res.status(500).json({ ok: false, error: err.message });
  }
});

/* ─────────────────────────────────────────────
   Enhanced Security & Performance Middleware
────────────────────────────────────────────── */
app.set("trust proxy", 1);

// Security headers
app.use(helmet({
  crossOriginEmbedderPolicy: false,
  contentSecurityPolicy: false // Adjust based on your needs
}));

// Compression for better performance
app.use(compression({
  filter: (req, res) => {
    if (req.headers['x-no-compression']) return false;
    return compression.filter(req, res);
  },
  level: 6,
  threshold: 1024
}));

// Rate limiting to prevent abuse
const limiter = rateLimit({
  windowMs: 15 * 60 * 1000, // 15 minutes
  max: 100, // Limit each IP to 100 requests per windowMs
  message: { error: "Too many requests, please try again later." },
  standardHeaders: true,
  legacyHeaders: false,
});
app.use('/api/', limiter);

// Stricter rate limiting for auth endpoints
const authLimiter = rateLimit({
  windowMs: 15 * 60 * 1000,
  max: 5, // Only 5 login attempts per 15 minutes
  message: { error: "Too many login attempts, please try again later." }
});

// CORS with optimized settings
app.use(cors({
  origin: process.env.NODE_ENV === 'production' 
    ? ["https://sulavtrader.netlify.app"] 
    : ["https://sulavtrader.netlify.app", "http://localhost:5500", "http://localhost:3000"],
  credentials: true,
  optionsSuccessStatus: 200,
  maxAge: 86400 // Cache preflight for 24 hours
}));

// Optimized body parsing
app.use(express.json({ 
  limit: "1mb", // Reduced from 2mb
  type: ['application/json', 'text/plain']
}));
app.use(express.urlencoded({ 
  extended: true, 
  limit: "1mb",
  parameterLimit: 1000
}));

// Session configuration with better performance
app.use(session({
  secret: process.env.SESSION_SECRET || "supersecretkey",
  resave: false,
  saveUninitialized: false,
  name: 'billing.sid', // Custom session name
  cookie: {
    httpOnly: true,
    sameSite: "none",
    secure: process.env.NODE_ENV === 'production',
    maxAge: 1000 * 60 * 60 * 2 // Extended to 2 hours
  },
  rolling: true // Reset expiry on activity
}));

// Static files with caching
app.use(express.static(path.join(__dirname, "public"), {
  maxAge: process.env.NODE_ENV === 'production' ? '1d' : '0',
  etag: true,
  lastModified: true
}));

/* ─────────────────────────────────────────────
   Optimized Helper Functions (with caching potential)
────────────────────────────────────────────── */
const requireAuth = (req, res, next) => {
  if (req.session?.userId) return next();
  return res.status(401).json({ success: false, message: "Unauthorized" });
};

// Memoized JSON operations for better performance
const jsonCache = new Map();
const toJSONString = (val) => {
  if (val == null) return "[]";
  if (typeof val === "string") return val;
  
  const key = JSON.stringify(val);
  if (jsonCache.has(key)) return jsonCache.get(key);
  
  try { 
    const result = JSON.stringify(val);
    if (jsonCache.size > 1000) jsonCache.clear(); // Prevent memory leaks
    jsonCache.set(key, result);
    return result;
  } catch { 
    return "[]"; 
  }
};

const parseItems = (val) => {
  if (!val) return [];
  if (Array.isArray(val)) return val;
  if (typeof val === "object") return val;
  
  if (jsonCache.has(val)) return jsonCache.get(val);
  
  try { 
    const result = JSON.parse(val);
    if (jsonCache.size > 1000) jsonCache.clear();
    jsonCache.set(val, result);
    return result;
  } catch { 
    return []; 
  }
};

// Optimized number conversion
const toNum = (v) => {
  if (typeof v === 'number') return isFinite(v) ? v : 0;
  const num = Number(v);
  return isFinite(num) ? num : 0;
};

// Pre-compiled query for better performance
const QUERIES = {
  CREATE_DELETED_BILLS_TABLE: `
    CREATE TABLE IF NOT EXISTS deleted_bills (
      id INT NOT NULL AUTO_INCREMENT PRIMARY KEY,
      original_bill_id INT NULL,
      estimate_no VARCHAR(50) NOT NULL,
      customer_name VARCHAR(255) NOT NULL,
      customer_phone VARCHAR(50),
      bill_date DATE NULL,
      items JSON NULL,
      sub_total DECIMAL(10,2) DEFAULT 0.00,
      discount DECIMAL(10,2) DEFAULT 0.00,
      grand_total DECIMAL(10,2) DEFAULT 0.00,
      received DECIMAL(10,2) DEFAULT 0.00,
      balance DECIMAL(10,2) DEFAULT 0.00,
      amount_words TEXT,
      user_id VARCHAR(100) NOT NULL,
      deleted_at TIMESTAMP DEFAULT CURRENT_TIMESTAMP,
      INDEX idx_user_estimate (user_id, estimate_no),
      INDEX idx_deleted_at (deleted_at)
    )
  `,
  
  // Pre-compiled prepared statements
  SELECT_BILL_BY_ESTIMATE: "SELECT * FROM bills WHERE estimate_no = ? AND user_id = ? LIMIT 1",
  SELECT_USER_BILLS: "SELECT * FROM bills WHERE user_id = ? ORDER BY updated_at DESC, created_at DESC LIMIT ?",
  INSERT_BILL: `INSERT INTO bills
    (estimate_no, customer_name, customer_phone, bill_date, items,
     sub_total, discount, grand_total, received, balance, amount_words, user_id)
    VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?)`,
  UPDATE_BILL: `UPDATE bills SET
    customer_name=?, customer_phone=?, bill_date=?, items=?,
    sub_total=?, discount=?, grand_total=?, received=?, balance=?, amount_words=?
    WHERE id=?`,
  SELECT_DELETED_BILLS: "SELECT * FROM deleted_bills WHERE user_id = ? ORDER BY deleted_at DESC LIMIT ?"
};

// Optimized bill data builder with object pooling concept
const buildBillDataRow = (row) => {
  return JSON.stringify({
    estimateNo: row.estimate_no ?? "",
    customerName: row.customer_name ?? "",
    customerPhone: row.customer_phone ?? "",
    billDate: row.bill_date ?? null,
    items: parseItems(row.items),
    subTotal: toNum(row.sub_total),
    discount: toNum(row.discount),
    grandTotal: toNum(row.grand_total),
    received: toNum(row.received),
    balance: toNum(row.balance),
    amountWords: row.amount_words ?? ""
  });
};

/* ─────────────────────────────────────────────
   Enhanced Health Check
────────────────────────────────────────────── */
app.get("/api/health", async (_req, res) => {
  const startTime = Date.now();
  try {
    const conn = await db.getConnection();
    await conn.ping();
    conn.release();
    
    const responseTime = Date.now() - startTime;
    res.json({ 
      ok: true, 
      responseTime: `${responseTime}ms`,
      timestamp: new Date().toISOString(),
      uptime: process.uptime()
    });
  } catch (e) {
    res.status(500).json({ 
      ok: false, 
      error: e.message,
      responseTime: `${Date.now() - startTime}ms`
    });
  }
});

/* ─────────────────────────────────────────────
   Optimized Authentication
────────────────────────────────────────────── */
app.post("/api/login", authLimiter, (req, res) => {
  const { email, password } = req.body || {};
  
  // Early validation
  if (!email || !password) {
    return res.status(400).json({ 
      success: false, 
      message: "Email and password are required" 
    });
  }

  const ADMIN_EMAIL = (process.env.ADMIN_EMAIL || "").trim().toLowerCase();
  const ADMIN_PASSWORD = (process.env.ADMIN_PASSWORD || "").trim();

  // Secure comparison without detailed logging in production
  if (process.env.NODE_ENV !== 'production') {
    console.log("Login attempt for:", email);
  }

  if (
    email.trim().toLowerCase() === ADMIN_EMAIL &&
    password.trim() === ADMIN_PASSWORD
  ) {
    req.session.userId = "admin";
    req.session.loginTime = Date.now();
    return res.json({ success: true, userId: "admin" });
  }
  
  return res.status(401).json({ success: false, message: "Invalid credentials" });
});

app.post("/api/logout", (req, res) => {
  req.session.destroy((err) => {
    if (err) console.error("Session destroy error:", err);
    res.json({ success: true });
  });
});

app.get("/api/me", (req, res) => {
  if (!req.session?.userId) {
    return res.status(401).json({ authenticated: false });
  }
  res.json({ 
    authenticated: true, 
    userId: req.session.userId,
    loginTime: req.session.loginTime
  });
});

/* ─────────────────────────────────────────────
   Optimized Bills CRUD Operations
────────────────────────────────────────────── */

// Enhanced input validation
const validateBillInput = (body) => {
  const errors = [];
  if (!body.estimateNo?.toString().trim()) errors.push("Estimate number is required");
  if (!body.customerName?.toString().trim()) errors.push("Customer name is required");
  return errors;
};

app.post("/api/save-bill", requireAuth, async (req, res) => {
  const errors = validateBillInput(req.body);
  if (errors.length > 0) {
    return res.status(400).json({ success: false, message: errors.join(", ") });
  }

  const b = req.body;
  const userId = req.session.userId;
  const itemsStr = toJSONString(b.items);
  const billDate = b.billDate || null;

  try {
    const [existing] = await db.query(QUERIES.SELECT_BILL_BY_ESTIMATE, [
      String(b.estimateNo), userId
    ]);

    const billData = [
      b.customerName || "",
      b.customerPhone || "",
      billDate,
      itemsStr,
      toNum(b.subTotal),
      toNum(b.discount),
      toNum(b.grandTotal),
      toNum(b.received),
      toNum(b.balance),
      b.amountWords || ""
    ];

    if (existing.length > 0) {
      await db.query(QUERIES.UPDATE_BILL, [...billData, existing[0].id]);
      return res.json({ success: true, action: "updated", id: existing[0].id });
    } else {
      const [result] = await db.query(QUERIES.INSERT_BILL, [
        String(b.estimateNo),
        ...billData,
        userId
      ]);
      return res.json({ success: true, action: "inserted", id: result.insertId });
    }
  } catch (err) {
    console.error("Save bill error:", err);
    return res.status(500).json({ success: false, message: "Database error" });
  }
});

// Paginated bill retrieval
app.get("/api/get-bills", requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100); // Max 100 records
    const offset = parseInt(req.query.offset) || 0;

    const [rows] = await db.query(
      QUERIES.SELECT_USER_BILLS.replace('LIMIT ?', 'LIMIT ? OFFSET ?'),
      [userId, limit, offset]
    );

    // Batch process for better performance
    const bills = rows.map(r => ({
      ...r,
      billData: buildBillDataRow(r)
    }));

    res.json({
      data: bills,
      pagination: {
        limit,
        offset,
        count: bills.length
      }
    });
  } catch (err) {
    console.error("Error fetching bills:", err);
    res.status(500).json({ error: "Failed to fetch bills" });
  }
});

// Optimized single bill retrieval
app.get("/api/bills/:estimateNo", requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const { estimateNo } = req.params;

    if (!estimateNo) {
      return res.status(400).json({ success: false, message: "Estimate number required" });
    }

    const [rows] = await db.query(QUERIES.SELECT_BILL_BY_ESTIMATE, [
      String(estimateNo), userId
    ]);

    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Bill not found" });
    }

    const bill = rows[0];
    bill.billData = buildBillDataRow(bill);
    res.json(bill);
  } catch (err) {
    console.error("Error fetching bill:", err);
    res.status(500).json({ error: "Failed to fetch bill" });
  }
});

// Enhanced partial update with validation
app.patch("/api/update-bill", requireAuth, async (req, res) => {
  const { estimateNo, updates } = req.body || {};
  
  if (!estimateNo || !updates || typeof updates !== 'object') {
    return res.status(400).json({ 
      success: false, 
      message: "Missing estimateNo or valid updates object" 
    });
  }

  const userId = req.session.userId;

  try {
    const [rows] = await db.query(QUERIES.SELECT_BILL_BY_ESTIMATE, [
      String(estimateNo), userId
    ]);
    
    if (!rows.length) {
      return res.status(404).json({ success: false, message: "Bill not found" });
    }
    
    const row = rows[0];
    const current = {
      estimateNo: row.estimate_no,
      customerName: row.customer_name,
      customerPhone: row.customer_phone,
      billDate: row.bill_date,
      items: parseItems(row.items),
      subTotal: toNum(row.sub_total),
      discount: toNum(row.discount),
      grandTotal: toNum(row.grand_total),
      received: toNum(row.received),
      balance: toNum(row.balance),
      amountWords: row.amount_words || ""
    };

    const merged = { ...current, ...updates };

    await db.query(QUERIES.UPDATE_BILL, [
      merged.customerName || "",
      merged.customerPhone || "",
      merged.billDate || null,
      toJSONString(merged.items),
      toNum(merged.subTotal),
      toNum(merged.discount),
      toNum(merged.grandTotal),
      toNum(merged.received),
      toNum(merged.balance),
      merged.amountWords || "",
      row.id
    ]);

    return res.json({ success: true, message: "Bill updated", id: row.id });
  } catch (err) {
    console.error("Update bill error:", err);
    return res.status(500).json({ success: false, message: "Database error" });
  }
});

/* ─────────────────────────────────────────────
   Optimized Soft Delete with Transaction Management
────────────────────────────────────────────── */
app.delete("/api/delete-bill", requireAuth, async (req, res) => {
  const { estimateNo } = req.body || {};
  
  if (!estimateNo) {
    return res.status(400).json({ success: false, message: "Missing estimateNo" });
  }

  const userId = req.session.userId;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(QUERIES.SELECT_BILL_BY_ESTIMATE, [
      String(estimateNo), userId
    ]);
    
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: "Bill not found" });
    }
    
    const bill = rows[0];

    // Insert into deleted_bills
    await conn.query(
      `INSERT INTO deleted_bills
       (original_bill_id, estimate_no, customer_name, customer_phone, bill_date, items,
        sub_total, discount, grand_total, received, balance, amount_words, user_id, deleted_at)
       VALUES (?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, ?, NOW())`,
      [
        bill.id,
        bill.estimate_no,
        bill.customer_name,
        bill.customer_phone,
        bill.bill_date,
        toJSONString(bill.items),
        bill.sub_total,
        bill.discount,
        bill.grand_total,
        bill.received,
        bill.balance,
        bill.amount_words,
        userId
      ]
    );

    // Delete from bills
    await conn.query("DELETE FROM bills WHERE id = ?", [bill.id]);

    await conn.commit();
    return res.json({ success: true, message: "Bill moved to deleted history", id: bill.id });
  } catch (err) {
    await conn.rollback();
    console.error("Soft delete error:", err);
    return res.status(500).json({ success: false, message: "Database error" });
  } finally {
    conn.release();
  }
});

/* ─────────────────────────────────────────────
   Enhanced Deleted Bills Management
────────────────────────────────────────────── */
app.get("/api/get-deleted-bills", requireAuth, async (req, res) => {
  try {
    const userId = req.session.userId;
    const limit = Math.min(parseInt(req.query.limit) || 50, 100);
    
    const [rows] = await db.query(QUERIES.SELECT_DELETED_BILLS, [userId, limit]);
    return res.json(rows);
  } catch (err) {
    console.error("Get deleted bills error:", err);
    return res.status(500).json({ success: false, message: "Database error" });
  }
});

app.post("/api/restore-bill", requireAuth, async (req, res) => {
  const { id } = req.body || {};
  if (!id) {
    return res.status(400).json({ success: false, message: "Missing id" });
  }

  const userId = req.session.userId;
  const conn = await db.getConnection();

  try {
    await conn.beginTransaction();

    const [rows] = await conn.query(
      "SELECT * FROM deleted_bills WHERE id = ? AND user_id = ? LIMIT 1",
      [id, userId]
    );
    
    if (!rows.length) {
      await conn.rollback();
      return res.status(404).json({ success: false, message: "Deleted bill not found" });
    }
    
    const d = rows[0];

    await conn.query(QUERIES.INSERT_BILL, [
      d.estimate_no,
      d.customer_name,
      d.customer_phone,
      d.bill_date,
      toJSONString(d.items),
      d.sub_total,
      d.discount,
      d.grand_total,
      d.received,
      d.balance,
      d.amount_words,
      userId
    ]);

    await conn.query("DELETE FROM deleted_bills WHERE id = ?", [id]);

    await conn.commit();
    return res.json({ success: true, message: "Bill restored successfully" });
  } catch (err) {
    await conn.rollback();
    console.error("Restore bill error:", err);
    return res.status(500).json({ success: false, message: "Database error" });
  } finally {
    conn.release();
  }
});

app.delete("/api/permanent-delete-bill", requireAuth, async (req, res) => {
  const { id } = req.body || {};
  if (!id) {
    return res.status(400).json({ success: false, message: "Missing id" });
  }

  const userId = req.session.userId;

  try {
    const [result] = await db.query(
      "DELETE FROM deleted_bills WHERE id = ? AND user_id = ?",
      [id, userId]
    );
    
    if (result.affectedRows === 0) {
      return res.status(404).json({ success: false, message: "Record not found" });
    }
    
    return res.json({ success: true, message: "Permanently deleted" });
  } catch (err) {
    console.error("Permanent delete error:", err);
    return res.status(500).json({ success: false, message: "Database error" });
  }
});

/* ─────────────────────────────────────────────
   Application Bootstrap & Startup
────────────────────────────────────────────── */
app.get("/", (_req, res) => {
  res.json({
    message: "Billing System API is running 🚀",
    version: "2.0.0",
    timestamp: new Date().toISOString()
  });
});

async function initDb() {
  try {
    await db.query(QUERIES.CREATE_DELETED_BILLS_TABLE);
    
    // Create indexes for better performance if they don't exist
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_bills_user_estimate ON bills(user_id, estimate_no)
    `).catch(() => {}); // Ignore if already exists
    
    await db.query(`
      CREATE INDEX IF NOT EXISTS idx_bills_updated_at ON bills(updated_at DESC)
    `).catch(() => {});
    
    console.log("✅ Database tables and indexes initialized");
  } catch (error) {
    console.error("❌ Database initialization failed:", error);
    throw error;
  }
}

// Graceful shutdown handling
process.on('SIGTERM', async () => {
  console.log('SIGTERM received, shutting down gracefully');
  await db.end();
  process.exit(0);
});

process.on('SIGINT', async () => {
  console.log('SIGINT received, shutting down gracefully');
  await db.end();
  process.exit(0);
});

app.listen(PORT, async () => {
  try {
    const conn = await db.getConnection();
    conn.release();
    await initDb();
    console.log("✅ Database connection OK and tables ready");
    console.log(`🚀 Server running at http://localhost:${PORT}`);
    console.log(`📊 Environment: ${process.env.NODE_ENV || 'development'}`);
  } catch (e) {
    console.error("❌ Startup failed:", e.message);
    process.exit(1);
  }
});