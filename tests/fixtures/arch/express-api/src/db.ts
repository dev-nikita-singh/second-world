// @ts-nocheck — fixture
import { Pool } from "pg";

// SEEDED: ARCH006 (no max)
export const pool = new Pool({ connectionString: process.env.DATABASE_URL });
