import { IsIn, IsNotEmpty, IsString, IsUUID } from "class-validator";

export class CopilotConfirmDto {
  @IsUUID()
  conversationId!: string;

  @IsString()
  @IsNotEmpty()
  actionId!: string;

  @IsIn(["approve", "reject"])
  decision!: "approve" | "reject";
}
