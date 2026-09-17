import { Module } from "@nestjs/common";

import { AiMetaController } from "./ai.controller.js";
import { HealthController } from "./health.controller.js";

@Module({
  controllers: [HealthController, AiMetaController],
})
export class MetaModule {}
