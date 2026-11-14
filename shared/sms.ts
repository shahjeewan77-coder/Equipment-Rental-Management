export type SmsEvent = 
  | "approved" 
  | "on_transit" 
  | "locked_dispatch" 
  | "dispatched" 
  | "delivered" 
  | "returned" 
  | "festive"
  | "test";

export const MESSAGE_MODES = ["off", "transit_and_delivery", "custom"] as const;
export type MessageMode = typeof MESSAGE_MODES[number];

export const SMS_EVENTS: SmsEvent[] = [
  "approved",
  "on_transit",
  "locked_dispatch",
  "dispatched",
  "delivered",
  "returned",
  "festive",
  "test",
];

export const MAX_CUSTOM_MESSAGE_LENGTH = 160;

export const SMS_EVENT_LABELS: Record<string, string> = {
  approved: "Order Approved",
  on_transit: "Message on Transit & Delivery",
  locked_dispatch: "Message on Transit & Delivery",
  dispatched: "Message on Transit & Delivery",
  delivered: "Message on Transit & Delivery",
  returned: "Returned",
  festive: "Festive Greeting",
  test: "Test Message",
};

export const FESTIVE_GREETING = `शुभ दीपावली!
बडिमालिका शटरिङ
फोन: ९८०४६३२५३७`;

export function toSmsPasalNumber(phone: string | null | undefined): string | null {
  if (!phone) return null;
  let cleaned = phone.replace(/\D/g, "");
  if (cleaned.length === 12 && cleaned.startsWith("977")) {
    cleaned = cleaned.slice(3);
  }
  if (cleaned.length === 10 && (cleaned.startsWith("9") || cleaned.startsWith("1"))) {
    return cleaned;
  }
  return cleaned.length >= 10 ? cleaned.slice(-10) : null;
}

export function isValidSmsPasalNumber(phone: string | null): boolean {
  if (!phone) return false;
  return /^[9][0-9]{9}$/.test(phone);
}

export function summarizeEquipment(items: Array<{ equipmentName?: string; billedQty?: number; actualQty?: number; unit?: string }> | undefined): string {
  if (!items || items.length === 0) return "";
  return items
    .map((item) => `${item.equipmentName || "सामान"} (${item.billedQty ?? item.actualQty ?? 0} ${item.unit || "वटा"})`)
    .join(", ");
}

export function buildSmsBody(params: {
  event: SmsEvent;
  customerName?: string;
  orderRef?: string;
  equipment?: string;
  businessName?: string;
}): string {
  const { event } = params;

  if (event === "on_transit" || event === "locked_dispatch") {
    return "तपाईंको अर्डर लोड भएको छ - बडिमालिका शटरिङ";
  }
  
  if (event === "dispatched" || event === "delivered") {
    return "तपाईंको अर्डर आइपुग्यो - बडिमालिका शटरिङ";
  }

  if (event === "festive") {
    return FESTIVE_GREETING;
  }

  if (event === "test") {
    return "यो बडिमालिका शटरिङबाट पठाइएको परिक्षण सन्देश हो।";
  }

  return "";
}