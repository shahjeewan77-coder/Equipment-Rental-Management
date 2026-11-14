import "dotenv/config";
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const q = async (label, sql) => {
  const r = await c.query(sql);
  console.log("\n=== " + label + " ===");
  console.log(JSON.stringify(r.rows, null, 1));
};
await q("orders by status", `select status, count(*)::int from orders group by status order by 1`);
await q("live orders with lines", `
  select o.status, c.name as customer, oi.equipment_id, e.name as equip,
         oi.actual_qty, oi.billed_qty, oi.units, oi.basis
  from orders o
  left join customers c on c.id=o.customer_id
  join order_items oi on oi.order_id=o.id
  left join equipment e on e.id=oi.equipment_id
  where o.status in ('pending_approval','approved','on_transit','on_rent','dispatched')
  order by o.status, c.name, oi.created_at`);
await q("on_rent rows", `select o.id, o.status, c.name as customer, i.invoice_no, o.dispatched_at
  from orders o left join customers c on c.id=o.customer_id
  left join invoices i on i.order_id=o.id
  where o.status='on_rent' order by o.dispatched_at desc`);
await c.end();
