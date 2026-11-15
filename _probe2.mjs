import "dotenv/config";
import pg from "pg";
const c = new pg.Client({ connectionString: process.env.DATABASE_URL });
await c.connect();
const r = await c.query(`
  select o.id, o.status, c.name as customer, i.invoice_no,
         (select count(*) from order_items oi where oi.order_id=o.id)::int as nlines,
         (select string_agg(e.name || ' ' || oi.actual_qty || '/' || oi.billed_qty, ', ' order by oi.created_at)
            from order_items oi left join equipment e on e.id=oi.equipment_id where oi.order_id=o.id) as summary
  from orders o left join customers c on c.id=o.customer_id
  left join invoices i on i.order_id=o.id
  where o.status in ('pending_approval','approved','on_transit','on_rent')
  order by o.status, o.created_at`);
console.log(JSON.stringify(r.rows, null, 1));
await c.end();
