import { Controller, Get, Module, Param } from "@nestjs/common";
import { ClockService, GreetingService } from "./greeting.service.ts";

@Controller("greetings")
export class GreetingController {
  // Class imported from another module and used only as a constructor type.
  constructor(private readonly greetings: GreetingService) {}

  @Get(":name")
  greet(@Param("name") name: string): { message: string } {
    return { message: this.greetings.greet(name) };
  }
}

@Module({ controllers: [GreetingController], providers: [GreetingService, ClockService] })
export class GreetingModule {}
