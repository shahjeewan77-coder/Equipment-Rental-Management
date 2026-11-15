// Direct probe of the SMS Pasal service function, with the real key from .env.
// Proves: (1) the key is read from the environment, (2) the exact provider result.
import "dotenv/config";
import { sendSms, smsPasalConfigured, missingSmsPasalVars, readSmsPasalConfig } from "../server/services/sms-pasal.ts";

const cfg = readSmsPasalConfig();
console.log("configured:", smsPasalConfigured());
console.log("missing:", missingSmsPasalVars());
console.log("endpoint:", cfg?.endpoint);
console.log("key prefix:", cfg?.apiKey?.slice(0, 12) + "…");

console.log("\n--- test send to 9804632537 ---");
const res = await sendSms({ to: "9804632537", body: "Equipment Rental: This is a test SMS. Your rental status updates are working." });
console.log(JSON.stringify(res, null, 2));

console.log("\n--- skip: no number ---");
console.log(JSON.stringify(await sendSms({ to: null, body: "x" }), null, 2));

console.log("\n--- skip: undialable ---");
console.log(JSON.stringify(await sendSms({ to: "12345", body: "x" }), null, 2));
