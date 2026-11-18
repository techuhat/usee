import { createContext } from 'react';

/** The shape (width over height) of the picture under the preview's overlays: its media's own. */
export const PictureAspect = createContext(16 / 9);
