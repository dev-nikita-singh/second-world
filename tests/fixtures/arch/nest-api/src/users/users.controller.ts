// @ts-nocheck — fixture for the Architecture Inspector (never executed)
import { Controller, Delete, Get, Post, UseGuards } from "@nestjs/common";
import { AuthGuard } from "../auth.guard.js";
import type { UsersService } from "./users.service.js";

@Controller("users")
export class UsersController {
  constructor(private readonly users: UsersService) {}

  @UseGuards(AuthGuard)
  @Get()
  list() {
    return this.users.list();
  }

  @UseGuards(AuthGuard)
  @Get(":id")
  get(id: string) {
    return this.users.get(id);
  }

  // SEEDED: ARCH007 (no guard while siblings have AuthGuard)
  @Delete(":id")
  remove(id: string) {
    return this.users.remove(id);
  }

  @UseGuards(AuthGuard)
  @Post()
  create() {
    return this.users.create();
  }
}
