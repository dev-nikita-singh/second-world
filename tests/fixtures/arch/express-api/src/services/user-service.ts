// @ts-nocheck — fixture
import { fetchInvoices } from "../clients/billing.js";
import { pool } from "../db.js";

export async function listUsersWithTeams() {
  const { rows } = await pool.query("SELECT * FROM users");
  for (const u of rows) {
    // SEEDED: ARCH005
    u.team = await pool.query("SELECT * FROM teams WHERE id = $1", [u.teamId]);
  }
  return rows;
}

export async function getUser(id) {
  const { rows } = await pool.query("SELECT * FROM users WHERE id = $1", [id]);
  return { ...rows[0], invoices: await fetchInvoices(id) };
}

export async function deleteUser(id) {
  await pool.query("DELETE FROM users WHERE id = $1", [id]);
}
