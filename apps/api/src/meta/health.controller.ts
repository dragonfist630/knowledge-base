import { Controller, Get } from "@nestjs/common";

interface HealthResponse {
  status: "ok";
}

@Controller("health")
export class HealthController {
  @Get()
  check(): HealthResponse {
    return { status: "ok" };
  }
}
