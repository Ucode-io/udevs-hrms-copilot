import {
  CanActivate,
  ExecutionContext,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import type { Request } from "express";
import { CallerService } from "./caller.service";
import type { CallerContext } from "../ucode/ucode.types";

export type CallerRequest = Request & { caller?: CallerContext };

/**
 * Resolves the bearer token on the way in and attaches the CallerContext to the
 * request. Every Copilot route sits behind this, so no handler ever has to
 * reason about who is asking or which Company they belong to.
 */
@Injectable()
export class CallerGuard implements CanActivate {
  constructor(private readonly callers: CallerService) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<CallerRequest>();
    const header = req.headers.authorization;
    if (!header?.toLowerCase().startsWith("bearer ")) {
      throw new UnauthorizedException("Bearer token required.");
    }
    req.caller = await this.callers.resolve(header.slice(7));
    return true;
  }
}

/** Injects the resolved CallerContext into a handler parameter. */
export const Caller = createParamDecorator(
  (_: unknown, context: ExecutionContext): CallerContext => {
    const req = context.switchToHttp().getRequest<CallerRequest>();
    if (!req.caller) throw new UnauthorizedException("No caller context.");
    return req.caller;
  },
);
