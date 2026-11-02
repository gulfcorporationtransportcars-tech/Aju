import { BadRequestException, PipeTransform } from "@nestjs/common";
import { ZodType, ZodTypeDef } from "zod";

// eslint-disable-next-line @typescript-eslint/no-explicit-any
type Schema<T> = ZodType<T, ZodTypeDef, any>;

/** Validate and parse a request body / query with a Zod schema: `@Body(zod(Schema))`. */
export class ZodPipe<T> implements PipeTransform<unknown, T> {
  constructor(private readonly schema: Schema<T>) {}

  transform(value: unknown): T {
    const result = this.schema.safeParse(value);
    if (!result.success) {
      throw new BadRequestException({
        message: "Validation failed",
        errors: result.error.issues.map((i) => ({ field: i.path.join("."), message: i.message })),
      });
    }
    return result.data;
  }
}

export const zod = <T>(schema: Schema<T>) => new ZodPipe(schema);
