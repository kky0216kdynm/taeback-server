require("dotenv").config();
const express = require("express");
const { Pool } = require("pg");
const cors = require("cors");
const path = require("path");

const app = express();

app.use(cors());
app.use(express.json());

// ----------------------------------------------------
// DB
// ----------------------------------------------------
const pool = new Pool({
  connectionString: process.env.DATABASE_URL,
  ssl: false,
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
// API
// ----------------------------------------------------
//포인트 입금 관련
const DEPOSIT = {
  bank: process.env.DEPOSIT_BANK_NAME || "은행명",
  account: process.env.DEPOSIT_ACCOUNT_NO || "계좌번호",
  holder: process.env.DEPOSIT_ACCOUNT_HOLDER || "예금주",
};

const MASTER_API_KEY = process.env.MASTER_API_KEY || "";
function requireMaster(req, res, next) {
  const key = req.header("x-master-key");
  if (!MASTER_API_KEY || key !== MASTER_API_KEY) {
    return res.status(401).json({ success: false, message: "MASTER 인증 실패" });
  }
  next();
}

// 1. 본사 인증
app.post("/auth/verify-head", async (req, res) => {
  const { inviteCode } = req.body;
  try {
    const headRes = await pool.query(
      "SELECT id, name FROM head_offices WHERE code = $1",
      [inviteCode]
    );

    if (headRes.rows.length === 0) {
      return res
        .status(404)
        .json({ success: false, message: "본사 코드가 틀렸습니다." });
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

// 2. 가맹점 로그인(지점id+가맹코드)
app.post("/auth/login-store", async (req, res) => {
  const { storeId, merchantCode } = req.body;
  try {
    const resStore = await pool.query(
      "SELECT id, name, head_office_id, status FROM stores WHERE id = $1 AND merchant_code = $2",
      [storeId, merchantCode]
    );

    if (resStore.rows.length > 0) {
      res.json({ success: true, message: "로그인 성공", store: resStore.rows[0] });
    } else {
      res
        .status(401)
        .json({ success: false, message: "가맹점 코드가 일치하지 않습니다." });
    }
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 3. 상품 조회
app.get("/products", async (req, res) => {
  const { headOfficeId } = req.query;
  try {
    const result = await pool.query(
      "SELECT * FROM products WHERE head_office_id = $1 ORDER BY id DESC",
      [headOfficeId]
    );
    res.json({ success: true, products: result.rows });
  } catch (err) {
    res.status(500).json({ success: false, error: err.message });
  }
});

// 4. 가맹점 코드만으로 로그인
app.post("/auth/login-store-by-code", async (req, res) => {
  const { merchantCode } = req.body;

  try {
    const result = await pool.query(
      `SELECT id, head_office_id, name, business_no, phone, status,
              to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at
       FROM stores
       WHERE merchant_code = $1
       LIMIT 1`,
      [merchantCode]
    );

    if (result.rows.length === 0) {
      return res
        .status(401)
        .json({ success: false, message: "가맹점 코드가 일치하지 않습니다." });
    }

    return res.json({ success: true, message: "로그인 성공", store: result.rows[0] });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 5. 주문 생성
app.post("/orders", async (req, res) => {
  const { storeId, items } = req.body;

  if (!storeId || !Array.isArray(items) || items.length === 0) {
    return res.status(400).json({ success: false, message: "storeId/items 필요" });
  }

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    const storeRes = await client.query(
      "SELECT id, head_office_id FROM stores WHERE id = $1",
      [storeId]
    );
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
        return res
          .status(400)
          .json({ success: false, message: `상품 불일치: ${it.productId}` });
      }
      total += price * it.qty;
    }

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

    await client.query("COMMIT");
    return res.json({ success: true, orderId });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

// 6. 본사: 주문목록
app.get("/head/orders", async (req, res) => {
  const { headOfficeId, status } = req.query;
  if (!headOfficeId)
    return res.status(400).json({ success: false, message: "headOfficeId 필요" });

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

// 7. 본사: 주문 상세
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
    if (head.rows.length === 0)
      return res.status(404).json({ success: false, message: "order 없음" });

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
// 8. 가맹점: 지갑(잔액) 조회
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

// 9. 가맹점: 포인트 충전 요청 생성
app.post("/topups/request", async (req, res) => {
  const { storeId, amount, depositorName } = req.body;

  const sid = Number(storeId);
  const amt = Number(amount);

  if (!sid || !amt || amt <= 0) {
    return res.status(400).json({ success: false, message: "storeId/amount 필요(0보다 커야 함)" });
  }

  try {
    // store 존재 확인 (원하면 status ACTIVE 체크도 가능)
    const s = await pool.query("SELECT id, merchant_code, name FROM stores WHERE id=$1", [sid]);
    if (s.rows.length === 0) {
      return res.status(404).json({ success: false, message: "store 없음" });
    }

    const merchantCode = s.rows[0].merchant_code;

    const r = await pool.query(
      `INSERT INTO point_topups (store_id, amount, depositor_name, status)
       VALUES ($1, $2, $3, 'requested')
       RETURNING id, store_id, amount, status, to_char(created_at, 'YYYY-MM-DD HH24:MI:SS') AS created_at`,
      [sid, amt, depositorName || null]
    );

    // 가맹점이 은행앱에서 이체할 때 헷갈리지 않게 “입금자명 규칙”을 내려줌
    // 예: TBK-A1B2C (가맹점 merchant_code)
    const depositGuide = {
      bank: DEPOSIT.bank,
      account: DEPOSIT.account,
      holder: DEPOSIT.holder,
      memoRule: `입금자명(권장): ${merchantCode}`, // 운영규칙: 입금자명에 merchantCode 넣게 유도
      topupId: r.rows[0].id,
    };

    return res.json({ success: true, topup: r.rows[0], depositGuide });
  } catch (err) {
    return res.status(500).json({ success: false, error: err.message });
  }
});

// 10. 가맹점: 내 충전 요청 목록
app.get("/topups", async (req, res) => {
  const storeId = Number(req.query.storeId);
  if (!storeId) return res.status(400).json({ success: false, message: "storeId 필요" });

  try {
    const r = await pool.query(
      `SELECT id, store_id, amount, status,
              depositor_name,
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

// 11. 마스터: 충전 승인(입금 확인 후)  ★핵심★
app.post("/admin/topups/:id/mark-paid", requireMaster, async (req, res) => {
  const topupId = Number(req.params.id);
  if (!topupId) return res.status(400).json({ success: false, message: "topupId 필요" });

  const client = await pool.connect();
  try {
    await client.query("BEGIN");

    // 중복 승인 방지: row 잠금
    const t = await client.query(
      "SELECT id, store_id, amount, status FROM point_topups WHERE id=$1 FOR UPDATE",
      [topupId]
    );
    if (t.rows.length === 0) {
      await client.query("ROLLBACK");
      return res.status(404).json({ success: false, message: "topup 없음" });
    }

    const topup = t.rows[0];
    if (topup.status === "paid") {
      await client.query("ROLLBACK");
      return res.json({ success: true, message: "이미 승인된 topup", topupId });
    }
    if (topup.status !== "requested") {
      await client.query("ROLLBACK");
      return res.status(400).json({ success: false, message: `처리 불가 상태: ${topup.status}` });
    }

    // 1) topup 상태 변경
    await client.query(
      "UPDATE point_topups SET status='paid', paid_at=now() WHERE id=$1",
      [topupId]
    );

    // 2) 지갑 upsert(+amount)
    await client.query(
      `INSERT INTO store_wallets(store_id, balance)
       VALUES($1, $2)
       ON CONFLICT(store_id)
       DO UPDATE SET balance = store_wallets.balance + EXCLUDED.balance, updated_at=now()`,
      [topup.store_id, topup.amount]
    );

    // 3) 원장 기록
    await client.query(
      `INSERT INTO point_ledger(store_id, type, amount, ref_type, ref_id, memo)
       VALUES($1, 'CHARGE', $2, 'TOPUP', $3, '관리자 입금확인 충전')`,
      [topup.store_id, topup.amount, topupId]
    );

    await client.query("COMMIT");

    // 승인 후 잔액 리턴(프론트 편하게)
    const w = await pool.query(
      "SELECT store_id, balance FROM store_wallets WHERE store_id=$1",
      [topup.store_id]
    );

    return res.json({ success: true, topupId, storeId: topup.store_id, wallet: w.rows[0] });
  } catch (err) {
    await client.query("ROLLBACK");
    return res.status(500).json({ success: false, error: err.message });
  } finally {
    client.release();
  }
});

//12. 프로필 조회
app.get("/profile", async (req,res)=>{
  const storeId = Number(req.query.storeId);
  if(!storeId) return res.status(400).json({success:false, message:"storeId 필요"});

  try{
    const r = await pool.query("SELECT * FROM store_profiles WHERE store_id=$1", [storeId]);
    if(!r.rows.length) return res.json({success:true, profile:null});
    res.json({success:true, profile:r.rows[0]});
  } catch(err){
    res.status(500).json({success:false, error: err.message});
  }
});
//13. 프로필 저장 및 수정
app.post("/profile/upsert", async (req,res)=>{
  const p = req.body;
  const storeId = Number(p.storeId);
  if(!storeId) return res.status(400).json({success:false, message:"storeId 필요"});

  try{
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
        p.depositorName || null
      ]
    );

    const r = await pool.query("SELECT * FROM store_profiles WHERE store_id=$1", [storeId]);
    res.json({success:true, profile:r.rows[0]});
  } catch(err){
    res.status(500).json({success:false, error: err.message});
  }
});
// 포인트 요청 생성
app.post("/topups/request", async (req,res)=>{
  const { storeId, amount, depositorName } = req.body;
  const sid = Number(storeId);
  const amt = Number(amount);
  if(!sid || !amt || amt<=0) return res.status(400).json({success:false, message:"storeId/amount 필요"});

  try{
    const s = await pool.query("SELECT id, merchant_code FROM stores WHERE id=$1", [sid]);
    if(!s.rows.length) return res.status(404).json({success:false, message:"store 없음"});

    // 프로필의 입금자명 기본값
    const prof = await pool.query("SELECT depositor_name FROM store_profiles WHERE store_id=$1", [sid]);
    const depositor = depositorName || (prof.rows[0]?.depositor_name ?? null);

    const r = await pool.query(
      `INSERT INTO point_topups(store_id, amount, depositor_name, status)
       VALUES($1,$2,$3,'requested')
       RETURNING id, store_id, amount, status, to_char(created_at,'YYYY-MM-DD HH24:MI:SS') created_at`,
      [sid, amt, depositor]
    );

    const depositGuide = {
      bank: process.env.DEPOSIT_BANK_NAME || "신한은행",
      account: process.env.DEPOSIT_ACCOUNT_NO || "100-037-544100",
      holder: process.env.DEPOSIT_ACCOUNT_HOLDER || "주식회사 태백마스터",
      memoRule: `입금자명(권장): ${s.rows[0].merchant_code}`,
      topupId: r.rows[0].id,
    };

    res.json({success:true, topup:r.rows[0], depositGuide});
  } catch(err){
    res.status(500).json({success:false, error: err.message});
  }
});

app.get("/points/history", async (req,res)=>{
  const storeId = Number(req.query.storeId);
  const limit = Number(req.query.limit || 50);
  if(!storeId) return res.status(400).json({success:false, message:"storeId 필요"});

  try{
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
    res.json({success:true, items:r.rows});
  } catch(err){
    res.status(500).json({success:false, error: err.message});
  }
});
// 주문 생성 라우트 내부에서 client = await pool.connect() 후 BEGIN 상태라고 가정

// 1) 총액 계산 total (기존 로직 유지)

// 2) 지갑 row 잠금
const w = await client.query(
  "SELECT balance FROM store_wallets WHERE store_id=$1 FOR UPDATE",
  [storeId]
);
const balance = w.rows.length ? Number(w.rows[0].balance) : 0;

// 지갑 없으면 생성(0원)
if (w.rows.length === 0) {
  await client.query("INSERT INTO store_wallets(store_id, balance) VALUES($1, 0)", [storeId]);
}

if (balance < total) {
  await client.query("ROLLBACK");
  return res.status(400).json({
    success:false,
    message:`포인트가 부족합니다. (보유:${balance}, 필요:${total})`,
    needed: total - balance
  });
}

// 3) 잔액 차감
await client.query(
  "UPDATE store_wallets SET balance = balance - $1, updated_at=now() WHERE store_id=$2",
  [total, storeId]
);

// 4) 주문 insert (기존대로 orders, order_items 생성)
// -> orderId 생성

// 5) 원장 기록 (ORDER_DEBIT)
await client.query(
  `INSERT INTO point_ledger(store_id, type, amount, ref_type, ref_id, memo)
   VALUES($1,'ORDER_DEBIT',$2,'ORDER',$3,'발주 결제 차감')`,
  [storeId, -total, orderId]
);



// ----------------------------------------------------
// Static + SPA
// ----------------------------------------------------
const distPath = path.join(__dirname, "dist");
app.use(express.static(distPath));

// ✅ API 테스트용은 SPA catch-all 보다 "위"에 둬야 함
app.get("/__whoami", (req, res) => {
  res.json({
    ok: true,
    service: "taeback-api",
    time: new Date().toISOString(),
  });
});

// ✅ SPA 라우팅: 맨 마지막
app.get(/^\/(?!auth|products|orders|head|__whoami).*/, (req, res) => {
  res.sendFile(path.join(distPath, "index.html"));
});

// 서버 실행
const PORT = process.env.PORT || 3000;
app.listen(PORT, () => console.log(`🚀 서버 실행 중: 포트 ${PORT}`));
