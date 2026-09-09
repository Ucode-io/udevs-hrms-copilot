import { Transform, Type } from "class-transformer";
import {
  IsNotEmpty,
  IsOptional,
  IsString,
  IsUUID,
  MaxLength,
  ValidateIf,
  ValidateNested,
} from "class-validator";
import { MAX_ATTACHMENT_BYTES } from "../attachment";

export class CopilotContextDto {
  /** Current HRMS route, for situational awareness. */
  @IsOptional()
  @IsString()
  @MaxLength(300)
  route?: string;
}

/** base64 grows by 4/3, plus padding. */
const MAX_BASE64_CHARS = Math.ceil(MAX_ATTACHMENT_BYTES / 3) * 4 + 8;

export class CopilotAttachmentDto {
  @IsString()
  @IsNotEmpty()
  @MaxLength(255)
  name!: string;

  /** What the browser called it. Advisory — the extension decides how it is read. */
  @IsString()
  @MaxLength(120)
  mediaType!: string;

  /** File bytes as base64, without the `data:` prefix. */
  @IsString()
  @IsNotEmpty()
  @MaxLength(MAX_BASE64_CHARS)
  data!: string;
}

export class CopilotChatDto {
  /** Continue an existing Conversation; omit to start a new one. */
  @IsOptional()
  @IsUUID()
  conversationId?: string;

  /**
   * Optional only when a file comes with it: "here, add these" is a complete
   * request when the list is attached.
   */
  @Transform(({ value }) =>
    typeof value === "string" ? value.trim() || undefined : value,
  )
  @ValidateIf((o) => !o.attachment || o.message !== undefined)
  @IsString()
  @IsNotEmpty()
  @MaxLength(8000)
  message?: string;

  /** One file per message — a spreadsheet, a CSV, a PDF or a photo of a list. */
  @IsOptional()
  @ValidateNested()
  @Type(() => CopilotAttachmentDto)
  attachment?: CopilotAttachmentDto;

  @IsOptional()
  @ValidateNested()
  @Type(() => CopilotContextDto)
  context?: CopilotContextDto;
}
