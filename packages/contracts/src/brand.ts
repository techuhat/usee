declare const brand: unique symbol;

/**
 * Nominal typing for primitives. Both `ProjectId` and `AssetId` are strings at
 * runtime, but the brand stops one being passed where the other is expected.
 * Branded values are produced only by the matching constructor or schema.
 */
export type Brand<Value, Name extends string> = Value & { readonly [brand]: Name };
