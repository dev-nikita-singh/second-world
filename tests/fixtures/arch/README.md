# Architecture Inspector fixture repos (owner: sw-arch)

Small, never-executed projects with known components, edges and seeded rule hits. Each folder has an
`expected.json` checked by `tests/integration/architecture/fixtures.test.ts`. Source files carry
`// @ts-nocheck` because their framework packages (NestJS, Prisma, pg, …) are intentionally not installed.
