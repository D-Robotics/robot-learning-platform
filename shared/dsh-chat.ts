/** User-uploaded pixels only; no URLs or pre-existing attachment references. */
export type DshImageUpload = {
  mediaType: 'image/png' | 'image/jpeg';
  base64: string;
};

export type DshImageAccepted = {
  mediaType: 'image/png' | 'image/jpeg';
  width: number;
  height: number;
  bytes: number;
};

export type DshImageInputCapability = {
  enabled: boolean;
  models: string[];
  maxImageBytes: number;
  maxImageDimension: number;
  maxImagePixels: number;
  mediaTypes: ['image/png', 'image/jpeg'];
};

export type DshChatRequest = {
  message: string;
  model?: string;
  sessionId?: string;
  turnId?: string;
  context?: { modelId?: string; deviceId?: string; computeResourceId?: string };
  image?: DshImageUpload;
};
