// @ts-nocheck — fixture
import { Injectable } from "@nestjs/common";
import { PrismaClient } from "@prisma/client";

const prisma = new PrismaClient();

@Injectable()
export class UsersService {
  list() {
    return prisma.user.findMany();
  }
  get(id: string) {
    return prisma.user.findUnique({ where: { id } });
  }
  remove(id: string) {
    return prisma.user.delete({ where: { id } });
  }
  async create() {
    // SEEDED: ARCH011 (floating promise in a handler path)
    this.audit("create");
    return prisma.user.create({ data: {} });
  }
  async audit(_what: string): Promise<void> {}
}
