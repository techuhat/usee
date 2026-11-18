import { z } from 'zod';

export const COORDINATE_SPACES = ['capture', 'display', 'normalized', 'project'] as const;

/**
 * Which frame a position is measured in. Persisted pointer data carries its
 * space so later crops, scales and rotations can map it correctly.
 */
export type CoordinateSpace = (typeof COORDINATE_SPACES)[number];
export const coordinateSpaceSchema = z.enum(COORDINATE_SPACES);

const finite = z.number().finite();

export const pointSchema = z.object({ x: finite, y: finite }).readonly();
export type Point = z.output<typeof pointSchema>;

export const pixelSizeSchema = z
  .object({ width: z.number().int().positive(), height: z.number().int().positive() })
  .readonly();
export type PixelSize = z.output<typeof pixelSizeSchema>;

export const rectangleSchema = z
  .object({ x: finite, y: finite, width: finite.nonnegative(), height: finite.nonnegative() })
  .readonly();
export type Rectangle = z.output<typeof rectangleSchema>;

/** Rational frame rate, e.g. 60000/1001 for 59.94 fps; never a float. */
export const frameRateSchema = z
  .object({ numerator: z.number().int().positive(), denominator: z.number().int().positive() })
  .readonly();
export type FrameRate = z.output<typeof frameRateSchema>;
