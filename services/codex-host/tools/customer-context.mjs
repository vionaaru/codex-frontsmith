// Доверенный инструмент Host: контакт клиента Frontsmith по client_id.
//
//   Codex → get_customer_context(client_id) → CustomerProvider → CRM
//         → минимальный набор полей → Privacy Service.prepare (в CodexHost) → Codex
//
// Инструмент выполняется в процессе Host: модель не получает ни адрес CRM, ни токен,
// ни идентификатор контакта CRM. Исходные значения в thread не попадают — результат
// любого инструмента Host проходит prepare, при отказе Privacy Service модель получает
// только код ошибки. Заметки и теги не передаются: модели они для этой задачи не нужны.
export function getCustomerContextTool(provider) {
  return {
    name: "get_customer_context",
    description: "Возвращает контакт клиента Frontsmith (имя, телефон, email) по client_id. Значения приходят тегами <PII .../>.",
    inputSchema: {
      type: "object",
      properties: { client_id: { type: "string", description: "client_id клиента Frontsmith (UUID)" } },
      required: ["client_id"],
      additionalProperties: false
    },
    handler: async ({ client_id: clientId }) => {
      let customer;
      try {
        customer = await provider.getCustomer(String(clientId ?? ""));
      } catch (error) {
        if (error.code === "invalid_input") return "invalid_client_id";
        throw error;
      }
      if (!customer) return "customer_not_found";
      return [
        `client_id: ${customer.id}`,
        `Клиент: ${customer.displayName}`,
        customer.phoneDisplay ? `Телефон: ${customer.phoneDisplay}` : null,
        customer.email ? `Email: ${customer.email}` : null
      ].filter(Boolean).join("\n");
    }
  };
}
