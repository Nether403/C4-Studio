import { GoogleGenAI } from "@google/genai";
import { ModelTier } from "../types";

// Helper to check for API key when using Pro models
export const ensureApiKey = async (model: ModelTier): Promise<void> => {
  if (model === ModelTier.NANO_BANANA_PRO) {
    if (window.aistudio) {
      const hasKey = await window.aistudio.hasSelectedApiKey();
      if (!hasKey) {
        await window.aistudio.openSelectKey();
        // Double check after modal might have closed
        const hasKeyAfter = await window.aistudio.hasSelectedApiKey();
        if (!hasKeyAfter) {
          throw new Error("API Key selection is required for Nano Banana Pro.");
        }
      }
    }
  }
};

const getClient = (): GoogleGenAI => {
  // Always create a new instance to pick up potentially new keys from the environment/window context
  return new GoogleGenAI({ apiKey: process.env.API_KEY });
};

export const generateImage = async (
  prompt: string,
  model: ModelTier,
  aspectRatio: string = "1:1"
): Promise<string> => {
  await ensureApiKey(model);
  const ai = getClient();

  const config: any = {
    imageConfig: {
      aspectRatio: aspectRatio,
    }
  };

  // Pro model supports High Quality size
  if (model === ModelTier.NANO_BANANA_PRO) {
     config.imageConfig.imageSize = "2K";
  }

  try {
    const response = await ai.models.generateContent({
      model: model,
      contents: {
        parts: [{ text: prompt }],
      },
      config: config,
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        const base64EncodeString = part.inlineData.data;
        return `data:${part.inlineData.mimeType};base64,${base64EncodeString}`;
      }
    }
    throw new Error("No image data returned from generation.");
  } catch (error: any) {
    console.error("Generation Error:", error);
    throw new Error(error.message || "Failed to generate image.");
  }
};

export const editImage = async (
  imageBase64: string,
  prompt: string,
  model: ModelTier
): Promise<string> => {
  await ensureApiKey(model);
  const ai = getClient();
  
  // Strip header if present
  const cleanBase64 = imageBase64.replace(/^data:image\/(png|jpeg|webp);base64,/, "");

  try {
    const response = await ai.models.generateContent({
      model: model,
      contents: {
        parts: [
            {
                inlineData: {
                    mimeType: 'image/png',
                    data: cleanBase64
                }
            },
            { text: prompt }
        ],
      },
      // Nano Banana supports editing via simple generateContent
    });

    for (const part of response.candidates?.[0]?.content?.parts || []) {
      if (part.inlineData) {
        const base64EncodeString = part.inlineData.data;
        return `data:${part.inlineData.mimeType};base64,${base64EncodeString}`;
      }
    }
    throw new Error("No image data returned from edit.");
  } catch (error: any) {
    console.error("Edit Error:", error);
    throw new Error(error.message || "Failed to edit image.");
  }
};