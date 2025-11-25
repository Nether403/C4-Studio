export enum AppMode {
  EDIT = 'EDIT',
  GENERATE = 'GENERATE'
}

export enum ModelTier {
  NANO_BANANA = 'gemini-2.5-flash-image',
  NANO_BANANA_PRO = 'gemini-3-pro-image-preview'
}

export interface Layer {
  id: string;
  type: 'image' | 'generation' | 'segment';
  name: string;
  url: string; // Base64 or Blob URL
  visible: boolean;
  opacity: number;
}

export interface GenerationConfig {
  prompt: string;
  negativePrompt: string;
  aspectRatio: string;
  model: ModelTier;
}

export interface Toast {
  id: string;
  message: string;
  type: 'success' | 'error' | 'info';
}

// Global augmentation for AI Studio key selection
declare global {
  interface AIStudio {
    hasSelectedApiKey: () => Promise<boolean>;
    openSelectKey: () => Promise<void>;
  }

  interface Window {
    aistudio?: AIStudio;
  }
}