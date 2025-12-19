import { useEffect, useMemo, useState } from "react";

export default function App() {
  const [headCode, setHeadCode] = useState("");
  const [headOffice, setHeadOffice] = useState(null); // {id,name}
  const [error, setError] = useState("");
  const [loading, setLoading] = useState(false);

  // orders
  const [orders, setOrders] = useState([]);
  const [ordersLoading, setOrdersLoading] = useState(false);
  const [ordersError, setOrdersError] = useState("");
  const [statusFilter, setStatusFilter] = useState(""); // pending/processing/done 등 너 DB 값에 맞추면 됨

  const isLoggedIn = !!headOffice?.id;

  async function verifyHead() {
    setError("");
    setLoading(true);
    try {
      const res = await fetch("/auth/verify-head", {
        method: "POST",
        headers: { "Content-Type": "application/json" },
        body: JSON.stringify({ inviteCode: headCode.trim().toUpperCase() }),
      });

      const data = await res.json().catch(() => ({}));
      if (!res.ok) {
        throw new Error(data?.message || data?.error || "본사 코드 인증 실패");
      }

      setHeadOffice(data.headOffice);
    } catch (e) {
      setError(e.message);
      setHeadOffice(null);
    } finally {
      setLoading(false);
    }
  }

  async function loadOrders() {
    if (!headOffice?.id) return;
    setOrdersError("");
    setOrdersLoading(true);

    try {
      const qs = new URLSearchParams({ headOfficeId: String(headOffice.id) });
      if (statusFilter) qs.set("status", statusFilter);

      const res = await fetch(`/head/orders?${qs.toString()}`);
      const data = await res.json().catch(() => ({}));
      if (!res.ok) throw new Error(data?.message || data?.error || "주문 목록 불러오기 실패");

      setOrders(data.orders || []);
    } catch (e) {
      setOrdersError(e.message);
    } finally {
      setOrdersLoading(false);
    }
  }

  useEffect(() => {
    if (isLoggedIn) loadOrders();
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [isLoggedIn, statusFilter]);

  function logout() {
    setHeadOffice(null);
    setOrders([]);
    setHeadCode("");
    setStatusFilter("");
    setError("");
    setOrdersError("");
  }

  return (
    <div style={styles.page}>
      <div style={styles.header}>
        <div>
          <div style={styles.title}>본사 관리 시스템</div>
          <div style={styles.subTitle}>발주 관리 및 통계</div>
        </div>

        {isLoggedIn && (
          <div style={styles.headerRight}>
            <div style={styles.badge}>{headOffice.name}</div>
            <button onClick={logout} style={styles.ghostBtn}>로그아웃</button>
          </div>
        )}
      </div>

      {!isLoggedIn ? (
        <div style={styles.card}>
          <div style={styles.cardTitle}>본사 코드 인증</div>
          <div style={styles.row}>
            <input
              value={headCode}
              onChange={(e) => setHeadCode(e.target.value)}
              placeholder="예: TBK_MAIN"
              style={styles.input}
            />
            <button
              onClick={verifyHead}
              disabled={!headCode.trim() || loading}
              style={{
                ...styles.primaryBtn,
                opacity: !headCode.trim() || loading ? 0.6 : 1,
              }}
            >
              {loading ? "인증 중..." : "인증하기"}
            </button>
          </div>
          {error && <div style={styles.error}>{error}</div>}
        </div>
      ) : (
        <div style={{ display: "grid", gap: 16 }}>
          <div style={styles.card}>
            <div style={styles.cardTitle}>발주 내역</div>

            <div style={{ display: "flex", gap: 10, alignItems: "center" }}>
              <button onClick={loadOrders} style={styles.ghostBtn} disabled={ordersLoading}>
                {ordersLoading ? "새로고침..." : "새로고침"}
              </button>

              <select
                value={statusFilter}
                onChange={(e) => setStatusFilter(e.target.value)}
                style={styles.select}
              >
                <option value="">전체 상태</option>
                <option value="pending">대기중</option>
                <option value="processing">처리중</option>
                <option value="done">완료</option>
              </select>
            </div>

            {ordersError && <div style={styles.error}>{ordersError}</div>}

            <div style={{ marginTop: 12 }}>
              {ordersLoading ? (
                <div style={styles.muted}>불러오는 중...</div>
              ) : orders.length === 0 ? (
                <div style={styles.muted}>주문이 없습니다.</div>
              ) : (
                <div style={styles.table}>
                  <div style={{ ...styles.tr, ...styles.th }}>
                    <div>주문ID</div>
                    <div>가맹점</div>
                    <div>상태</div>
                    <div style={{ textAlign: "right" }}>금액</div>
                    <div style={{ textAlign: "right" }}>시간</div>
                  </div>

                  {orders.map((o) => (
                    <div key={o.id} style={styles.tr}>
                      <div>#{o.id}</div>
                      <div>{o.store_name}</div>
                      <div>{o.status}</div>
                      <div style={{ textAlign: "right" }}>{Number(o.total_amount).toLocaleString()}원</div>
                      <div style={{ textAlign: "right" }}>{formatDate(o.created_at)}</div>
                    </div>
                  ))}
                </div>
              )}
            </div>
          </div>

          <div style={styles.muted}>
            다음 단계: 주문 클릭하면 상세(`/head/orders/:orderId`)까지 붙여줄게.
          </div>
        </div>
      )}
    </div>
  );
}

function formatDate(v) {
  if (!v) return "";
  const d = new Date(v);
  if (Number.isNaN(d.getTime())) return String(v);
  return d.toLocaleString();
}

const styles = {
  page: { fontFamily: "system-ui, -apple-system, Segoe UI, Roboto", padding: 24, background: "#f5f7fb", minHeight: "100vh" },
  header: { display: "flex", justifyContent: "space-between", alignItems: "center", marginBottom: 16 },
  headerRight: { display: "flex", gap: 10, alignItems: "center" },
  title: { fontSize: 20, fontWeight: 800 },
  subTitle: { fontSize: 12, color: "#6b7280", marginTop: 4 },
  badge: { background: "#eef2ff", color: "#3730a3", padding: "6px 10px", borderRadius: 999, fontSize: 12, fontWeight: 700 },
  card: { background: "white", borderRadius: 16, padding: 16, boxShadow: "0 10px 25px rgba(0,0,0,0.06)" },
  cardTitle: { fontSize: 16, fontWeight: 800, marginBottom: 12 },
  row: { display: "flex", gap: 10 },
  input: { flex: 1, padding: "12px 12px", borderRadius: 12, border: "1px solid #e5e7eb", outline: "none" },
  select: { padding: "10px 12px", borderRadius: 12, border: "1px solid #e5e7eb", outline: "none" },
  primaryBtn: { padding: "12px 14px", borderRadius: 12, border: "none", background: "#2563eb", color: "white", fontWeight: 800, cursor: "pointer" },
  ghostBtn: { padding: "10px 12px", borderRadius: 12, border: "1px solid #e5e7eb", background: "white", fontWeight: 700, cursor: "pointer" },
  error: { marginTop: 10, color: "#ef4444", fontSize: 12, fontWeight: 700 },
  muted: { color: "#6b7280", fontSize: 12 },
  table: { marginTop: 10, border: "1px solid #eef2f7", borderRadius: 12, overflow: "hidden" },
  tr: { display: "grid", gridTemplateColumns: "100px 1fr 140px 140px 220px", gap: 10, padding: "12px 12px", borderTop: "1px solid #eef2f7", alignItems: "center" },
  th: { background: "#f8fafc", fontWeight: 800, borderTop: "none" },
};
