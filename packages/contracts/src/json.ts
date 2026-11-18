import { z } from 'zod';

export type JsonPrimitive = boolean | null | number | string;
export type JsonValue =
  JsonPrimitive | readonly JsonValue[] | { readonly [key: string]: JsonValue };

/** Accepts only values that survive a JSON round trip unchanged. */
export const jsonValueSchema: z.ZodType<JsonValue> = z.json();
