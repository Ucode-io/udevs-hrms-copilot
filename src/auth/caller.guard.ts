import {
  BadRequestException,
  CanActivate,
  ExecutionContext,
  Inject,
  Injectable,
  UnauthorizedException,
  createParamDecorator,
} from "@nestjs/common";
import type { Request } from "express";
import { CONFIG, type CopilotConfig } from "../config/configuration";
import { CallerService } from "./caller.service";
import type { CallerContext } from "../ucode/ucode.types";

export type CallerRequest = Request & { caller?: CallerContext };

/** The header the HRMS panel names its own ucode project with. */
export const PROJECT_HEADER = "project-id";

/**
 * Resolves the bearer token on the way in and attaches the CallerContext to the
 * request. Every Copilot route sits behind this, so no handler ever has to
 * reason about who is asking, which Company they belong to, or which project
 * their data lives in.
 */
@Injectable()
export class CallerGuard implements CanActivate {
  constructor(
    private readonly callers: CallerService,
    @Inject(CONFIG) private readonly config: CopilotConfig,
  ) {}

  async canActivate(context: ExecutionContext): Promise<boolean> {
    const req = context.switchToHttp().getRequest<CallerRequest>();
    const header = req.headers.authorization;
    if (!header?.toLowerCase().startsWith("bearer ")) {
      throw new UnauthorizedException("Bearer token required.");
    }
    req.caller = await this.callers.resolve(
      header.slice(7),
      this.projectId(req),
    );
    return true;
  }

  /**
   * The project the panel says it is on, or the configured one.
   *
   * The fallback is what makes the two deploys independent: the panel that is
   * live right now sends no such header, and without it every request would
   * 400 in the window between shipping this service and rebuilding the panel.
   */
  private projectId(req: CallerRequest): string {
    const raw = req.headers[PROJECT_HEADER];
    const value = (Array.isArray(raw) ? raw[0] : raw)?.trim();
    if (!value) return this.config.ucode.projectId;
    // Shape-checked because it is pasted into a query string. ucode decides
    // whether the caller may touch the project; this only decides that the
    // value is a project id at all.
    if (!UUID.test(value)) {
      throw new BadRequestException(`${PROJECT_HEADER} must be a uuid.`);
    }
    return value;
  }
}

const UUID =
  /^[0-9a-f]{8}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{4}-[0-9a-f]{12}$/i;

/** Injects the resolved CallerContext into a handler parameter. */
export const Caller = createParamDecorator(
  (_: unknown, context: ExecutionContext): CallerContext => {
    const req = context.switchToHttp().getRequest<CallerRequest>();
    if (!req.caller) throw new UnauthorizedException("No caller context.");
    return req.caller;
  },
);
