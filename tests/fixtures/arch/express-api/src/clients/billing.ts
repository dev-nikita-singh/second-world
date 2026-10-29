// @ts-nocheck — fixture
import axios from "axios";

export async function fetchInvoices(userId) {
  // SEEDED: ARCH001 (no timeout)
  const res = await axios.get(`https://billing.example.com/users/${userId}/invoices`);
  return res.data;
}
