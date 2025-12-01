// index.js

require('dotenv').config();
const express = require('express');
const { Pool } = require('pg');
const crypto = require('crypto');

const app = express();
app.use(express.json());

// ------------------ DB 연결 ------------------
const pool = new Pool({
  host: process.env.DB_HOST || 'localhost',
  port: Number(process.env.DB_PORT || 5432),
  user: process.env.DB_USER || 'postgres',
  password: process.env.DB_PASSWORD,
  database: process.env.DB_NAME || 'taeback_app',
});

console.log('DB config in index.js =', {
  host: process.env.DB_HOST,
  port: process.env.DB_PORT,
  user: process.env.DB_USER,
  database: process.env.DB_NAME,
});

// 🔐 해시용 시크릿 (반드시 .env 에 INVITE_SECRET 넣어줘!)
const INVITE_SECRET = process.env.INVITE_SECRET || 'CHANGE_ME_INVITE_SECRET';

// ------------------ 유틸 함수 ------------------

// 랜덤 초대코드 생성 (사람이 보는 코드, 평문)
function generateInviteCode(length = 24) {
  const bytes = crypto.randomBytes(length * 2);
  return bytes
    .toString('base64')
    .replace(/[^A-Z0-9]/gi, '')
    .slice(0, length)
    .toUpperCase();
}

// 코드 해시 (DB에 저장용)
function hashInviteCode(code) {
  return crypto
    .createHmac('sha256', INVITE_SECRET)
    .update(code)
    .digest('hex');
}

// 헬스체크용
app.get('/health', async (req, res) => {
  try {
    const result = await pool.query('SELECT NOW()');
    res.json({ ok: true, now: result.rows[0].now });
  } catch (e) {
    console.error(e);
    res.status(500).json({ ok: false, error: e.message });
  }
});

// ------------------ 1) 본사 생성 ------------------

app.post('/head-offices', async (req, res) => {
  const { name, brandCode } = req.body;

  if (!name || !brandCode) {
    return res.status(400).json({ message: 'name, brandCode 둘 다 필요합니다.' });
  }

  try {
    const result = await pool.query(
      `
      INSERT INTO head_offices (name, brand_code)
      VALUES ($1, $2)
      RETURNING *;
      `,
      [name, brandCode]
    );

    res.status(201).json(result.rows[0]);
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: '본사 생성 중 오류', error: e.message });
  }
});

// ------------------ 2) 초대 코드 생성 ------------------

app.post('/head-offices/:id/invite-codes', async (req, res) => {
  const headOfficeId = Number(req.params.id);
  const { maxUses = 10, daysValid = 7 } = req.body;

  if (!headOfficeId) {
    return res.status(400).json({ message: '올바른 headOfficeId 가 필요합니다.' });
  }

  try {
    while (true) {
      const code = generateInviteCode(24);          // 평문 코드
      const codeHash = hashInviteCode(code);        // 🔐 해시

      try {
        const result = await pool.query(
          `
          INSERT INTO head_office_invite_codes
            (head_office_id, code_hash, max_uses, expires_at, status, used_count)
          VALUES
            ($1, $2, $3, NOW() + ($4 || ' days')::interval, 'ACTIVE', 0)
          RETURNING id;
          `,
          [headOfficeId, codeHash, maxUses, daysValid]
        );

        return res.status(201).json({
          inviteCode: code,                   // 본사/가맹점에게 보여줄 평문 코드
          inviteCodeId: result.rows[0].id,    // 내부용 ID
        });
      } catch (err) {
        if (err.code === '23505') {
          // code_hash UNIQUE 충돌 → 다시 생성
          continue;
        }
        throw err;
      }
    }
  } catch (e) {
    console.error(e);
    res.status(500).json({ message: '초대 코드 생성 중 오류', error: e.message });
  }
});

// ------------------ 3) 가맹점 가입 (/stores/join) ------------------

// 하나의 초대코드로 여러 가맹점 가입 가능 (max_uses까지)
app.post('/stores/join', async (req, res) => {
  const { inviteCode, name, businessNo, phone } = req.body;
  console.log('[/stores/join] body =', req.body);

  if (!inviteCode || !name) {
    return res
      .status(400)
      .json({ message: 'inviteCode와 매장 name 은 필수입니다.' });
  }

  try {
    // 🔐 입력받은 초대코드를 동일한 방식으로 해시
    const codeHash = hashInviteCode(inviteCode);

    // 1. 코드 유효성 체크
    const { rows } = await pool.query(
      `
      SELECT *
      FROM head_office_invite_codes
      WHERE code_hash = $1
        AND status = 'ACTIVE'
        AND (expires_at IS NULL OR expires_at > NOW())
        AND used_count < max_uses
      `,
      [codeHash]
    );

    console.log('[/stores/join] invite rows =', rows);

    if (rows.length === 0) {
      return res.status(400).json({ message: '사용할 수 없는 코드입니다.' });
    }

    const invite = rows[0];

    // 2. 매장 생성
    const storeResult = await pool.query(
      `
      INSERT INTO stores (head_office_id, name, business_no, phone, status, created_at)
      VALUES ($1, $2, $3, $4, 'ACTIVE', NOW())
      RETURNING *;
      `,
      [invite.head_office_id, name, businessNo || null, phone || null]
    );

    console.log('[/stores/join] new store =', storeResult.rows[0]);

    // 3. 사용 횟수 증가
    await pool.query(
      `
      UPDATE head_office_invite_codes
      SET used_count = used_count + 1
      WHERE id = $1;
      `,
      [invite.id]
    );

    return res.status(201).json({
      store: storeResult.rows[0],
      headOfficeId: invite.head_office_id,
    });
  } catch (e) {
    console.error('[/stores/join] ERROR =', e);
    return res
      .status(500)
      .json({ message: '가맹점 가입 중 오류', error: e.message });
  }
});

// ------------------ 4) 가맹점 상품 목록 ------------------

app.get('/stores/:storeId/products', async (req, res) => {
  const { storeId } = req.params;

  try {
    // 1) 매장에서 head_office_id 찾기
    const storeResult = await pool.query(
      'SELECT * FROM stores WHERE id = $1',
      [storeId]
    );
    if (storeResult.rows.length === 0) {
      return res.status(404).json({ message: '매장을 찾을 수 없습니다.' });
    }

    const store = storeResult.rows[0];

    // 2) 해당 본사의 상품 목록 가져오기
    const productsResult = await pool.query(
      `
      SELECT id,
             head_office_id,
             name,
             subtitle,
             category,
             price,
             unit,
             stock,
             image_url,
             created_at
      FROM products
      WHERE head_office_id = $1
      ORDER BY id;
      `,
      [store.head_office_id]
    );

    return res.json(productsResult.rows);
  } catch (e) {
    console.error('[/stores/:storeId/products] ERROR =', e);
    return res.status(500).json({
      message: '상품 목록 조회 중 오류',
      error: e.message,
    });
  }
});

// ------------------ 서버 시작 ------------------

const port = process.env.PORT || 4000;
app.listen(port, () => {
  console.log(`Server running on http://localhost:${port}`);
});
