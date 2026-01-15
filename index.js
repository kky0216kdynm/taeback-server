
require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const path = require("path");
const crypto = require("crypto");

const multer = require("multer");
const xlsx = require("xlsx");
const upload = multer({ storage: multer.memoryStorage() });

const app = express();
app.use(cors());
app.use(express.json());

// ----------------------------------------------------
// DB
// ----------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: {
    rejectUnauthorized: false,
  },
});


// ✅ DB 세션 타임존을 KST로 고정
pool.on("connect", (client) => {
  client.query("SET TIME ZONE 'Asia/Seoul'");
});

pool
  .connect()
  .then(() => console.log("✅ DB 연결 성공!"))
  .catch((err) => console.error("❌ DB 연결 실패:", err.message));

// ----------------------------------------------------
// Deposit / Master Auth
// ----------------------------------------------------
const DEPOSIT = {
  bank: process.env.DEPOSIT_BANK_NAME || "KB국민은행",
  account: process.env.DEPOSIT_ACCOUNT_NO || "94580201623404",
  holder: process.env.DEPOSIT_ACCOUNT_HOLDER || "김광엽",
};

const MASTER_API_KEY = process.env.MASTER_API_KEY || "";
function requireMaster(req, res, next) {
  const key = req.header("x-master-key");
  if (!MASTER_API_KEY || key !== MASTER_API_KEY) {
    return res.status(401).json({ success: false, message: "MASTER 인증 실패" });
  }
  next();
}

// ----------------------------------------------------
// Utils
// ----------------------------------------------------
function makeDepositCode(headOfficeId, storeId, topupId) {
  // 규칙: 본사ID-가맹점ID-충전요청ID
  return `${headOfficeId}-${storeId}-${topupId}`;
}

function extractDepositCode(text) {
  if (!text) return null;
  const m = String(text).match(/\b(\d+)-(\d+)-(\d+)\b/);
  if (!m) return null;
  return { headOfficeId: Number(m[1]), storeId: Number(m[2]), topupId: Number(m[3]) };
}

function readExcel(buffer) {
  const wb = xlsx.read(buffer, { type: "buffer" });
  const sheetName = wb.SheetNames[0];
  const sheet = wb.Sheets[sheetName];
  return xlsx.utils.sheet_to_json(sheet, { defval: "" });
}

function normalizeStatus(v, fallback = "ACTIVE") {
  const s = String(v || "").trim().toUpperCase();
  if (s === "ACTIVE" || s === "SOLD_OUT" || s === "INACTIVE") return s;
  if (s === "품절") return "SOLD_OUT";
  if (s === "판매중") return "ACTIVE";
  if (s === "비활성") return "INACTIVE";
  return fallback;
}

// ✅ 12자리 영문+숫자 랜덤 (혼동문자 제거)
function generateSecureCode12() {
  const chars = "ABCDEFGHJKLMNPQRSTUVWXYZ23456789"; // I,O,0,1 제거
  const bytes = crypto.randomBytes(12);
  let out = "";
  for (let i = 0; i < 12; i++) out += chars[bytes[i] % chars.length];
  return out;
}

// ✅ stores.merchant_code 유니크 보장 생성
async function generateUniqueMerchantCode() {
  for (let i = 0; i < 50; i++) {
    const code = generateSecureCode12();
    const exists = await pool.query("SELECT 1 FROM stores WHERE merchant_code=$1", [code]);
    if (exists.rowCount === 0) return code;
  }
  return generateSecureCode12();
}

// ✅ head_offices.code 유니크 보장 생성
async function generateUniqueHeadOfficeCode() {
  for (let i = 0; i < 50; i++) {
    const code = generateSecureCode12();
    const exists = await pool.query("SELECT 1 FROM head_offices WHERE code=$1", [code]);
    if (exists.rowCount === 0) return code;
  }
  return generateSecureCode12();
}

// ----------------------------------------------------
// Core: TOPUP 승인 처리(공통 함수)
// ----------------------------------------------------
async function applyTopupPaid({ topupId, memo = "입금확인 충전", refType = "TOPUP" }) {
  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const t = await client.query(
      "SELECT id, store_id, amount, status FROM point_topups WHERE id=$1 FOR UPDATE",
      [topupId]
    );
    if (t.rows.length === 0) {
      await client.query("ROLLBACK");
      return { ok: false, status: 404, message: "topup 없음" };
    }

    const topup = t.rows[0];
    if (topup.status === "paid") {
      await client.query("ROLLBACK");
      return { ok: true, message: "이미 승인된 topup", topupId, storeId: topup.store_id };
    }
    if (topup.status !== "requested") {
      await client.query("ROLLBACK");
      return { ok: false, status: 400, message: `처리 불가 상태: ${topup.status}` };
    }

    await client.query("UPDATE point_topups SET status='paid', paid_at=now() WHERE id=$1", [topupId]);

    await client.query(
      `INSERT INTO store_wallets(store_id, balance)
       VALUES($1, $2)
       ON CONFLICT(store_id)
       DO UPDATE SET balance = store_wallets.balance + EXCLUDED.balance, updated_at=now()`,
      [topup.store_id, topup.amount]
    );

    await client.query(
      `INSERT INTO point_ledger(store_id, type, amount, ref_type, ref_id, memo)
       VALUES($1, 'CHARGE', $2, $3, $4, $5)`,
      [topup.store_id, topup.amount, refType, topupId, memo]
    );

    await client.query("COMMIT");

    const w = await pool.query("SELECT store_id, balance FROM store_wallets WHERE store_id=$1", [topup.store_id]);
    return { ok: true, topupId, storeId: topup.store_id, wallet: w.rows[0] };
  } catch (err) {
    await client.query("ROLLBACK");
    return { ok: false, status: 500, message: err.message };
  } finally {
    client.release();
  }
}

// ----------------------------------------------------
// AUTH
// ----------------------------------------------------

// 1) 본사 인증
app.post("/auth/verify-head", async (req, res) => {
  const { inviteCode } = req.body;
  try {
    const headRes = await pool.query("SELECT id, name FROM head_offices WHERE code = $1", [inviteCode]);

    if (headRes.rows.length === 0) {
      return res.status(404).json({ success: false, message: "본사 코드가 틀렸습니다." });
    }

    const headOffice = headRes.rows[0];
    const branchesRes = await pool.query(
      "SELECT id, name, address FROM stores WHERE head_office_id = $1 ORDER BY name ASC",
      [headOffice.id]
    );

    res.json({ success: true, headOffice, branches: branchesRes.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 2) 가맹점 로그인(지점id+가맹코드)
app.post("/auth/login-store", async (req, res) => {
  const { storeId, merchantCode } = req.body;
  try {
    const resStore = await pool.query(
      "SELECT id, name, head_office_id, status FROM stores WHERE id = $1 AND merchant_code = $2",
      [storeId, String(merchantCode || "").trim().toUpperCase()]
    );

    if (resStore.rows.length > 0) {
      res.json({ success: true, message: "로그인 성공", store: resStore.rows[0] });
    } else {
      res.status(401).json({ success: false, message: "가맹점 코드가 일치하지 않습니다." });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3) 가맹점 코드만으로 로그인
app.post("/auth/login-store-by-code", async (req, res) => {
  const { merchantCode } = req.body;

  try {
    const result = await pool.query(
      `SELECT id, head_office_id, name, status,
              to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
       FROM stores
       WHERE merchant_code = $1
       LIMIT 1`,
      [String(merchantCode || "").trim().toUpperCase()]
    );

    if (result.rows.length === 0) {
      return res.status(401).json({ success: false, message: "가맹점 코드가 일치하지 않습니다." });
    }

    return res.json({ success: true, message: "로그인 성공", store: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// PRODUCTS (가맹점/본사 웹에서 사용)
// ----------------------------------------------------
app.get("/products", async (req, res) => {
  const { headOfficeId } = req.query;
  try {
    const result = await pool.query("SELECT * FROM products WHERE head_office_id = $1 ORDER BY id DESC", [headOfficeId]);
    res.json({ success: true, products: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// ORDERS (포인트 차감 포함)
// ----------------------------------------------------
app.post("/orders", async (req, res) => {
  const { storeId, items } = req.body;

  if (!storeId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: "storeId/items 필요" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const storeRes = await client.query("SELECT id, head_office_id FROM stores WHERE id = $1", [storeId]);
    if (storeRes.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "store 없음" });
    }
    const headOfficeId = storeRes.rows[0].head_office_id;

    const productIds = items.map((i) => i.productId);
    const productsRes = await client.query(
      `SELECT id, price
       FROM products
       WHERE id = ANY($1::int[])
         AND head_office_id = $2`,
      [productIds, headOfficeId]
    );

    const priceMap = new Map(productsRes.rows.map((p) => [p.id, p.price]));

    let total = 0;
    for (const it of items) {
      const price = priceMap.get(it.productId);
      if (price == null) {
        await client.query("ROLLBACK");
        return res.status(400).json({ success: false, message: `상품 불일치: ${it.productId}` });
      }
      total += price * it.qty;
    }

    const w = await client.query("SELECT balance FROM store_wallets WHERE store_id=$1 FOR UPDATE", [storeId]);

    if (w.rows.length === 0) {
      await client.query("INSERT INTO store_wallets(store_id, balance) VALUES($1, 0)", [storeId]);
    }

    const balance = w.rows.length ? Number(w.rows[0].balance) : 0;

    if (balance < total) {
      await client.query("ROLLBACK");
      return res.status(400).json({
        success: false,
        message: `포인트가 부족합니다. (보유:${balance}, 필요:${total})`,
        needed: total - balance,
      });
    }

    await client.query("UPDATE store_wallets SET balance = balance - $1, updated_at=now() WHERE store_id=$2", [
      total,
      storeId,
    ]);

    const orderRes = await client.query(
      `INSERT INTO orders (store_id, head_office_id, status, total_amount)
       VALUES ($1, $2, 'pending', $3)
       RETURNING id`,
      [storeId, headOfficeId, total]
    );
    const orderId = orderRes.rows[0].id;

    for (const it of items) {
      const price = priceMap.get(it.productId);
      const lineTotal = price * it.qty;
      await client.query(
        `INSERT INTO order_items (order_id, product_id, qty, unit_price, line_total)
         VALUES ($1, $2, $3, $4, $5)`,
        [orderId, it.productId, it.qty, price, lineTotal]
      );
    }

    await client.query(
      `INSERT INTO point_ledger(store_id, type, amount, ref_type, ref_id, memo)
       VALUES($1,'ORDER_DEBIT',$2,'ORDER',$3,'발주 결제 차감')`,
      [storeId, -total, orderId]
    );

    await client.query("COMMIT");
    return res.json({ success: true, orderId });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// 본사 주문목록
app.get("/head/orders", async (req, res) => {
  const { headOfficeId, status } = req.query;
  if (!headOfficeId) return res.status(400).json({ success: false, message: "headOfficeId 필요" });

  try {
    const params = [headOfficeId];
    let where = "WHERE o.head_office_id = $1";
    if (status) {
      params.push(status);
      where += ` AND o.status = $2`;
    }

    const result = await pool.query(
      `SELECT o.id,
              o.store_id,
              s.name AS store_name,
              o.status,
              o.total_amount,
              to_char(o.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
       FROM orders o
       JOIN stores s ON s.id = o.store_id
       ${where}
       ORDER BY o.id DESC`,
      params
    );

    res.json({ success: true, orders: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 본사 주문상세
app.get("/head/orders/:orderId", async (req, res) => {
  const { orderId } = req.params;

  try {
    const head = await pool.query(
      `SELECT o.id,
              o.store_id,
              s.name AS store_name,
              o.head_office_id,
              o.status,
              o.total_amount,
              to_char(o.created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
       FROM orders o
       JOIN stores s ON s.id = o.store_id
       WHERE o.id = $1`,
      [orderId]
    );
    if (head.rows.length === 0) return res.status(404).json({ success: false, message: "order 없음" });

    const items = await pool.query(
      `SELECT oi.product_id, p.name, oi.qty, oi.unit_price, oi.line_total
       FROM order_items oi
       JOIN products p ON p.id = oi.product_id
       WHERE oi.order_id = $1
       ORDER BY oi.id ASC`,
      [orderId]
    );

    res.json({ success: true, order: head.rows[0], items: items.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// WALLET / TOPUP / LEDGER
// ----------------------------------------------------
app.get("/wallet", async (req, res) => {
  const storeId = Number(req.query.storeId);
  if (!storeId) return res.status(400).json({ success: false, message: "storeId 필요" });

  try {
    const r = await pool.query(
      `SELECT store_id, balance, to_char(updated_at, 'YYYY-MM-DD HH24:MI:SS') AS updated_at
       FROM store_wallets
       WHERE store_id = $1`,
      [storeId]
    );

    if (r.rows.length === 0) {
      return res.json({ success: true, wallet: { store_id: storeId, balance: 0 } });
    }
    return res.json({ success: true, wallet: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ 포인트 충전 요청 생성 + deposit_code 생성/저장/반환
app.post("/topups/request", async (req, res) => {
  const { storeId, amount } = req.body; // depositorName 제거

  const sid = Number(storeId);
  const amt = Number(amount);

  if (!sid || !amt || amt <= 0) {
    return res.status(400).json({ success: false, message: "storeId/amount 필요(0보다 커야 함)" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const s = await client.query("SELECT id, head_office_id, merchant_code FROM stores WHERE id=$1", [sid]);
    if (s.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "store 없음" });
    }
    const headOfficeId = Number(s.rows[0].head_office_id);
    const merchantCode = s.rows[0].merchant_code;

    // 1) 우선 requested 생성
    const r = await client.query(
      `INSERT INTO point_topups (store_id, amount, depositor_name, status)
       VALUES ($1, $2, NULL, 'requested')
       RETURNING id, store_id, amount, status,
                 to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at`,
      [sid, amt]
    );

    const topupId = Number(r.rows[0].id);

    // 2) depositCode = 본사-가맹점-요청ID
    const depositCode = makeDepositCode(headOfficeId, sid, topupId);

    // 3) deposit_code 저장 + depositor_name도 depositCode로 맞춰두기(예상 입금자명)
    await client.query(
      "UPDATE point_topups SET deposit_code=$1, depositor_name=$2 WHERE id=$3",
      [depositCode, depositCode, topupId]
    );

    await client.query("COMMIT");

    // ✅ UX용 안내: 입금자명은 depositCode를 ‘그대로’ 사용하게 만들기
    const depositGuide = {
      bank: DEPOSIT.bank,
      account: DEPOSIT.account,
      holder: DEPOSIT.holder,
      depositCode,
      depositorNameToUse: depositCode,                 // ★ 핵심
      depositorRule: `입금자명(필수): ${depositCode}`,   // ★ 핵심
      memoRule: `받는통장표시(메모)에도 가능하면 ${depositCode} 입력`,
      fallbackDepositorRule: `입금자명이 막히면(길이제한 등) 대신: ${merchantCode}`,
      topupId, // 앱이 바로 보여줄 수 있도록
    };

    return res.json({
      success: true,
      topup: { ...r.rows[0], deposit_code: depositCode, depositor_name: depositCode },
      depositGuide
    });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

app.get("/topups/:id", async (req, res) => {
  const id = Number(req.params.id);
  if (!id) return res.status(400).json({ success: false, message: "id 필요" });

  try {
    const r = await pool.query(
      `SELECT id, store_id, amount, status,
              depositor_name, deposit_code,
              to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
              to_char(paid_at, 'YYYY-MM-DD HH24:MI:SS') AS paid_at
       FROM point_topups WHERE id=$1`,
      [id]
    );
    if (r.rows.length === 0) return res.status(404).json({ success: false, message: "topup 없음" });
    return res.json({ success: true, topup: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});


app.get("/topups", async (req, res) => {
  const storeId = Number(req.query.storeId);
  if (!storeId) return res.status(400).json({ success: false, message: "storeId 필요" });

  try {
    const r = await pool.query(
      `SELECT id, store_id, amount, status,
              depositor_name,
              deposit_code,
              to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at,
              to_char(paid_at, 'YYYY-MM-DD HH24:MI:SS') AS paid_at
       FROM point_topups
       WHERE store_id = $1
       ORDER BY id DESC
       LIMIT 50`,
      [storeId]
    );
    return res.json({ success: true, topups: r.rows });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 마스터: 충전 승인(수동)
app.post("/admin/topups/:id/mark-paid", requireMaster, async (req, res) => {
  const topupId = Number(req.params.id);
  if (!topupId) return res.status(400).json({ success: false, message: "topupId 필요" });

  const result = await applyTopupPaid({
    topupId,
    memo: "관리자 입금확인 충전",
    refType: "TOPUP",
  });

  if (!result.ok) return res.status(result.status || 500).json({ success: false, message: result.message });
  return res.json({ success: true, ...result });
});

app.get("/points/history", async (req, res) => {
  const storeId = Number(req.query.storeId);
  const limit = Number(req.query.limit || 50);
  if (!storeId) return res.status(400).json({ success: false, message: "storeId 필요" });

  try {
    const r = await pool.query(
      `SELECT id, type, amount, ref_type, ref_id, memo,
              to_char(created_at,'YYYY-MM-DD') as date,
              to_char(created_at,'YYYY-MM-DD HH24:MI:SS') as created_at
       FROM point_ledger
       WHERE store_id=$1
       ORDER BY id DESC
       LIMIT $2`,
      [storeId, limit]
    );
    res.json({ success: true, items: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// PROFILE
// ----------------------------------------------------
app.get("/profile", async (req, res) => {
  const storeId = Number(req.query.storeId);
  if (!storeId) return res.status(400).json({ success: false, message: "storeId 필요" });

  try {
    const r = await pool.query("SELECT * FROM store_profiles WHERE store_id=$1", [storeId]);
    if (!r.rows.length) return res.json({ success: true, profile: null });
    res.json({ success: true, profile: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

app.post("/profile/upsert", async (req, res) => {
  const p = req.body;
  const storeId = Number(p.storeId);
  if (!storeId) return res.status(400).json({ success: false, message: "storeId 필요" });

  try {
    await pool.query(
      `INSERT INTO store_profiles(
        store_id, business_no, company_name, ceo_name, business_address,
        business_type, business_item, email, phone, depositor_name, updated_at
      ) VALUES (
        $1,$2,$3,$4,$5,$6,$7,$8,$9,$10, now()
      )
      ON CONFLICT(store_id) DO UPDATE SET
        business_no=EXCLUDED.business_no,
        company_name=EXCLUDED.company_name,
        ceo_name=EXCLUDED.ceo_name,
        business_address=EXCLUDED.business_address,
        business_type=EXCLUDED.business_type,
        business_item=EXCLUDED.business_item,
        email=EXCLUDED.email,
        phone=EXCLUDED.phone,
        depositor_name=EXCLUDED.depositor_name,
        updated_at=now()
      `,
      [
        storeId,
        p.businessNo || null,
        p.companyName || null,
        p.ceoName || null,
        p.businessAddress || null,
        p.businessType || null,
        p.businessItem || null,
        p.email || null,
        p.phone || null,
        p.depositorName || null,
      ]
    );

    const r = await pool.query("SELECT * FROM store_profiles WHERE store_id=$1", [storeId]);
    res.json({ success: true, profile: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ----------------------------------------------------
// ✅ MOCK BANK (운영 전 테스트용)
// ----------------------------------------------------
app.post("/admin/bank/mock-incoming", requireMaster, async (req, res) => {
  const { txId, amount, memo, depositor, occurredAt } = req.body;
  if (!txId || !amount) {
    return res.status(400).json({ success: false, message: "txId/amount 필요" });
  }

  const dup = await pool.query("SELECT 1 FROM bank_incoming_processed WHERE tx_id=$1", [txId]);
  if (dup.rows.length) {
    return res.json({ success: true, message: "이미 처리된 tx", txId });
  }

  const parsed = extractDepositCode(memo);
  if (!parsed) {
    await pool.query(
      `INSERT INTO bank_incoming_processed(tx_id, amount, depositor, memo, occurred_at)
       VALUES($1,$2,$3,$4,$5)`,
      [txId, Number(amount), depositor || null, memo || null, occurredAt || null]
    );
    return res.json({ success: true, matched: false, message: "depositCode 파싱 실패(수동처리 필요)" });
  }

  const depositCode = `${parsed.headOfficeId}-${parsed.storeId}-${parsed.topupId}`;

  const t = await pool.query(
    `SELECT id, store_id
     FROM point_topups
     WHERE deposit_code=$1`,
    [depositCode]
  );

  if (!t.rows.length) {
    await pool.query(
      `INSERT INTO bank_incoming_processed(tx_id, amount, depositor, memo, occurred_at)
       VALUES($1,$2,$3,$4,$5)`,
      [txId, Number(amount), depositor || null, memo || null, occurredAt || null]
    );
    return res.json({ success: true, matched: false, message: "deposit_code 매칭 실패(수동처리 필요)", depositCode });
  }

  const topupId = Number(t.rows[0].id);
  const storeId = Number(t.rows[0].store_id);

  await pool.query(
    `INSERT INTO bank_incoming_processed(tx_id, amount, depositor, memo, occurred_at, matched_topup_id, matched_store_id)
     VALUES($1,$2,$3,$4,$5,$6,$7)`,
    [txId, Number(amount), depositor || null, memo || null, occurredAt || null, topupId, storeId]
  );

  const result = await applyTopupPaid({
    topupId,
    memo: "KB 자동입금 확인 충전",
    refType: "BANK",
  });

  if (!result.ok) return res.status(result.status || 500).json({ success: false, message: result.message });

  return res.json({ success: true, matched: true, depositCode, ...result });
});

// ----------------------------------------------------
// MASTER APIs (통합관리 시스템용)
// ----------------------------------------------------

// ✅ 본사 목록 (+ 가맹점 수 포함)
app.get("/master/head-offices", requireMaster, async (req, res) => {
  try {
    const r = await pool.query(`
      SELECT
        ho.id, ho.name, ho.code, ho.manager_name, ho.address, ho.phone,
        COUNT(s.id)::int AS store_count
      FROM head_offices ho
      LEFT JOIN stores s ON s.head_office_id = ho.id
      GROUP BY ho.id
      ORDER BY ho.id DESC
    `);
    res.json({ success: true, headOffices: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ 본사 추가 (본사코드 12자리 랜덤 자동 생성)
app.post("/master/head-offices", requireMaster, async (req, res) => {
  const { name, manager_name, address, phone } = req.body;
  if (!name) return res.status(400).json({ success: false, message: "name 필요" });

  try {
    const code = await generateUniqueHeadOfficeCode();
    const r = await pool.query(
      `INSERT INTO head_offices (name, code, manager_name, address, phone)
       VALUES ($1, $2, $3, $4, $5)
       RETURNING id, name, code, manager_name, address, phone`,
      [name, code, manager_name ?? null, address ?? null, phone ?? null]
    );
    return res.status(201).json({ success: true, headOffice: r.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ 본사 수정
app.patch("/master/head-offices/:id", requireMaster, async (req, res) => {
  const id = Number(req.params.id);
  const { name, manager_name, address, phone } = req.body;

  try {
    const r = await pool.query(
      `UPDATE head_offices
       SET name = COALESCE($2, name),
           manager_name = COALESCE($3, manager_name),
           address = COALESCE($4, address),
           phone = COALESCE($5, phone)
       WHERE id = $1
       RETURNING id, name, code, manager_name, address, phone`,
      [id, name ?? null, manager_name ?? null, address ?? null, phone ?? null]
    );
    if (!r.rowCount) return res.status(404).json({ success: false, message: "본사 없음" });
    res.json({ success: true, headOffice: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ 본사 삭제
app.delete("/master/head-offices/:id", requireMaster, async (req, res) => {
  const id = Number(req.params.id);
  try {
    const r = await pool.query(`DELETE FROM head_offices WHERE id=$1`, [id]);
    if (!r.rowCount) return res.status(404).json({ success: false, message: "본사 없음" });
    res.json({ success: true });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ 가맹점 목록 (본사별)
app.get("/master/stores", requireMaster, async (req, res) => {
  const { headOfficeId } = req.query;
  if (!headOfficeId) return res.status(400).json({ success: false, message: "headOfficeId 필요" });

  try {
    const r = await pool.query(
      `SELECT id, head_office_id, name, address, phone, status, merchant_code,
              to_char(created_at,'YYYY-MM-DD HH24:MI:SS') AS created_at
       FROM stores
       WHERE head_office_id=$1
       ORDER BY id DESC`,
      [headOfficeId]
    );
    res.json({ success: true, stores: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ 가맹점 추가 (merchant_code 서버에서 자동 생성)
app.post("/master/stores", requireMaster, async (req, res) => {
  const { headOfficeId, name, address, phone, status } = req.body;

  if (!headOfficeId || !name) {
    return res.status(400).json({ success: false, message: "headOfficeId/name 필요" });
  }

  try {
    const merchantCode = await generateUniqueMerchantCode();

    const r = await pool.query(
      `INSERT INTO stores(head_office_id, name, merchant_code, address, phone, status)
       VALUES($1,$2,$3,$4,$5,$6)
       RETURNING *`,
      [Number(headOfficeId), String(name).trim(), merchantCode, address || null, phone || null, status || "ACTIVE"]
    );

    res.json({ success: true, store: r.rows[0] });
  } catch (err) {
    if (String(err.message || "").includes("merchant_code")) {
      return res.status(409).json({ success: false, message: "가맹점 코드 생성 충돌. 다시 시도하세요." });
    }
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ 가맹점 엑셀 업로드 (본사코드 기준, merchant_code 자동 생성)
app.post("/master/stores/upload", requireMaster, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "file 필요" });

  const rows = readExcel(req.file.buffer);
  const result = { inserted: 0, failed: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const headOfficeCode = String(row.head_office_code || row.본사코드 || "").trim();
      const storeName = String(row.store_name || row.가맹점명 || "").trim();
      const address = String(row.address || row.주소 || "").trim() || null;
      const phone = String(row.phone || row.연락처 || "").trim() || null;
      const status = normalizeStatus(row.status || row.상태 || "ACTIVE", "ACTIVE");

      if (!headOfficeCode || !storeName) throw new Error("head_office_code/store_name 필수");

      const h = await pool.query("SELECT id FROM head_offices WHERE code=$1", [headOfficeCode]);
      if (h.rowCount === 0) throw new Error(`본사코드 없음: ${headOfficeCode}`);

      const merchantCode = await generateUniqueMerchantCode();

      await pool.query(
        `INSERT INTO stores(head_office_id, name, merchant_code, address, phone, status)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [h.rows[0].id, storeName, merchantCode, address, phone, status]
      );

      result.inserted++;
    } catch (e) {
      result.failed.push({ rowIndex: i + 2, error: e.message });
    }
  }

  res.json({ success: true, ...result });
});

// ✅ 상품 목록 (본사 선택 후)
app.get("/master/products", requireMaster, async (req, res) => {
  const { headOfficeId } = req.query;
  if (!headOfficeId) return res.status(400).json({ success: false, message: "headOfficeId 필요" });

  try {
    const r = await pool.query(
      `SELECT id, head_office_id, name, category, price, unit, image_url, status,
              to_char(created_at,'YYYY-MM-DD HH24:MI:SS') AS created_at
       FROM products
       WHERE head_office_id=$1
       ORDER BY id DESC`,
      [headOfficeId]
    );
    res.json({ success: true, products: r.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ 상품 품절 토글 (재고 없이 status만: ACTIVE / SOLD_OUT)
app.patch("/master/products/:id/status", requireMaster, async (req, res) => {
  const { id } = req.params;
  const { status } = req.body;
  try {
    const r = await pool.query("UPDATE products SET status=$1 WHERE id=$2 RETURNING *", [
      normalizeStatus(status, "ACTIVE"),
      id,
    ]);
    res.json({ success: true, product: r.rows[0] });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// ✅ 상품 엑셀 업로드 (본사코드 기준)
app.post("/master/products/upload", requireMaster, upload.single("file"), async (req, res) => {
  if (!req.file) return res.status(400).json({ success: false, message: "file 필요" });

  const rows = readExcel(req.file.buffer);
  const result = { inserted: 0, failed: [] };

  for (let i = 0; i < rows.length; i++) {
    const row = rows[i];
    try {
      const headOfficeCode = String(row.head_office_code || row.본사코드 || "").trim();
      const name = String(row.name || row.상품명 || "").trim();
      const category = String(row.category || row.카테고리 || "").trim() || null;
      const price = Number(row.price || row.가격);
      const unit = String(row.unit || row.단위 || "").trim() || null;
      const status = normalizeStatus(row.status || row.상태 || "ACTIVE", "ACTIVE");

      if (!headOfficeCode || !name || Number.isNaN(price)) throw new Error("head_office_code/name/price 필수");

      const h = await pool.query("SELECT id FROM head_offices WHERE code=$1", [headOfficeCode]);
      if (h.rowCount === 0) throw new Error(`본사코드 없음: ${headOfficeCode}`);

      await pool.query(
        `INSERT INTO products(head_office_id, name, category, price, unit, status)
         VALUES($1,$2,$3,$4,$5,$6)`,
        [h.rows[0].id, name, category, price, unit, status]
      );

      result.inserted++;
    } catch (e) {
      result.failed.push({ rowIndex: i + 2, error: e.message });
    }
  }

  res.json({ success: true, ...result });
});

// ----------------------------------------------------
// Health Check
// ----------------------------------------------------
app.get("/__whoami", (req, res) => {
  res.json({
    ok: true,
    service: "taeback-api",
    time: new Date().toISOString(),
  });
});

// ----------------------------------------------------
// Static + SPA (✅ 반드시 맨 아래)
// ----------------------------------------------------
const distPath = path.join(__dirname, "dist");
app.use(express.static(distPath));

import ibkRouter from "./ibk.js";
app.use("/ibk", ibkRouter);



// SPA 라우팅 (API 경로 제외)
app.get(/^\/(?!auth|products|orders|head|wallet|topups|admin|profile|points|master|__whoami).*/, (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

// 서버 실행
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 서버 실행 중: 포트 ${PORT}`));
