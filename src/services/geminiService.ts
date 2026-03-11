import { GoogleGenAI, Type } from "@google/genai";

export interface Appearance {
  imageName: string;
  imageIndex: number;
  box_2d: [number, number, number, number];
}

export interface IdentifiedPerson {
  id: string;
  description: string;
  appearances: Appearance[];
}

/**
 * 优化后的识别服务：
 * 1. 使用极简 JSON 结构减少 Token 消耗，防止截断。
 * 2. 增加 maxOutputTokens。
 * 3. 自动补全图片名称。
 * @param images 图片数据数组
 * @param customApiKey 用户手动输入的 API Key
 */
// 修改后的前端 src/services/geminiService.ts
export async function processAttendanceImages(images) {
  const response = await fetch('/api/analyze-attendance', {
    method: 'POST',
    headers: { 'Content-Type': 'application/json' },
    body: JSON.stringify({ images })
  });
  const result = await response.json();
  return result.data;
}

  const ai = new GoogleGenAI({ apiKey });
  
  const contents: any[] = [];
  // 保持在 4-6 张图片以确保稳定性
  const imagesToProcess = images.slice(0, 6);
  
  imagesToProcess.forEach((img, index) => {
    const base64Data = img.data.includes(',') ? img.data.split(',')[1] : img.data;
    contents.push({ text: `[IMG ${index + 1}] ${img.name}` });
    contents.push({
      inlineData: {
        data: base64Data,
        mimeType: "image/jpeg",
      },
    });
  });

  const prompt = `
    你是一个顶级课堂考勤助手。这是一个大型课程（约 41 人）。
    请深度分析照片，识别出**尽可能多**的不重复到课人员。
    
    关键准则：
    1. **真实识别**：根据照片实际情况识别，不需要强行凑满 41 人。
    2. **必须有头**：仅识别头部清晰可见的人员，**严禁**识别只有身体、没有头部的目标。**严禁**将衣服、窗帘、椅子或其他非生物物体误认为人员。
    3. **全场扫描**：仔细寻找后排、角落、侧脸或被部分遮挡的真实人员。
    4. **跨图去重与关联**：
       - 通过面部、发型、衣着和座位位置确保同一个人只出现一次。
       - **跨图一致性**：如果一个人出现在多张图中，必须深度比对细节，确保确实是同一个人。如果无法 100% 确定是同一人，请作为不同人员处理。
    5. **详细描述**：对人员的特征进行详细描述（15-30字），包括性别、发型、眼镜、衣服颜色及款式、配饰、座位位置特征等。用中文进行描述。
    6. **严格使用极简 JSON 结构**：
       [{"id":"P1","d":"描述","a":[{"i":1,"b":[y,x,y,x]}]}]
       i 是图片索引(1-based)，b 是 [ymin, xmin, ymax, xmax]。
    
    请直接返回 JSON 数组，不要任何开头或结尾文字。
  `;

  contents.push({ text: prompt });

  const maxRetries = 3;
  let retryCount = 0;
  let lastError: any = null;

  while (retryCount <= maxRetries) {
    try {
      const response = await ai.models.generateContent({
        model: "gemini-3-flash-preview", // 切换到更稳定的模型并增加重试机制
        contents: [{ parts: contents }],
        config: {
          responseMimeType: "application/json",
          maxOutputTokens: 16384,
          responseSchema: {
            type: Type.ARRAY,
            items: {
              type: Type.OBJECT,
              properties: {
                id: { type: Type.STRING },
                d: { type: Type.STRING }, // description
                a: { // appearances
                  type: Type.ARRAY, 
                  items: { 
                    type: Type.OBJECT,
                    properties: {
                      i: { type: Type.INTEGER }, // imageIndex
                      b: { // box_2d
                        type: Type.ARRAY, 
                        items: { type: Type.NUMBER }
                      }
                    },
                    required: ["i", "b"]
                  }
                },
              },
              required: ["id", "d", "a"],
            },
          },
        },
      });

      // 增强日志记录，帮助诊断空响应问题
      console.log("AI Response received:", JSON.stringify({
        hasText: !!response.text,
        candidateCount: response.candidates?.length,
        finishReason: response.candidates?.[0]?.finishReason,
        partsCount: response.candidates?.[0]?.content?.parts?.length
      }));

      const text = response.text;
      if (!text) {
        const candidate = response.candidates?.[0];
        const finishReason = candidate?.finishReason;
        const safetyRatings = candidate?.safetyRatings;
        
        console.error("Empty AI response details:", {
          finishReason,
          safetyRatings,
          content: candidate?.content
        });
        
        if (finishReason === "SAFETY") {
          throw new Error("AI 识别被安全过滤器拦截。这通常是因为图片中包含敏感内容或被误判。请尝试更换角度更清晰的照片。");
        }
        if (finishReason === "RECITATION") {
          throw new Error("AI 识别触发了版权保护机制（Recitation）。请尝试重新上传。");
        }
        if (finishReason === "OTHER") {
          throw new Error("AI 识别因未知原因中断（FinishReason: OTHER）。可能是图片过大或处理超时，请尝试减少图片数量。");
        }
        
        throw new Error(`AI 未返回有效内容 (原因: ${finishReason || "未知"})。这可能是由于图片质量不佳、光线太暗或 AI 模型暂时繁忙。请尝试重新上传更清晰的照片。`);
      }
      
      // 清理 Markdown 并修剪空白
      const jsonText = text.trim()
        .replace(/^```json\n?/, "")
        .replace(/\n?```$/, "")
        .replace(/^```\n?/, "")
        .replace(/\n?```$/, "");
      
      try {
        const compactData = JSON.parse(jsonText);
        
        // 将极简结构映射回标准结构
        return compactData.map((item: any) => ({
          id: item.id,
          description: item.d,
          appearances: item.a.map((app: any) => ({
            imageIndex: app.i,
            imageName: imagesToProcess[app.i - 1]?.name || `Image ${app.i}`,
            box_2d: app.b as [number, number, number, number]
          }))
        }));
      } catch (parseError: any) {
        console.error("JSON Parse Error. Raw text:", jsonText);
        throw new Error(`AI 返回的数据格式错误 (JSON 解析失败): ${parseError.message}。原始数据片段: ${jsonText.substring(0, 100)}...`);
      }
    } catch (error: any) {
      lastError = error;
      // 检查是否是 503 错误或高负载错误
      const isRetryable = error.message?.includes('503') || 
                        error.message?.includes('high demand') || 
                        error.message?.includes('UNAVAILABLE') ||
                        error.status === 'UNAVAILABLE';
      
      if (isRetryable && retryCount < maxRetries) {
        retryCount++;
        const delay = Math.pow(2, retryCount) * 1000; // 指数退避: 2s, 4s, 8s
        console.warn(`Gemini 繁忙 (503)，正在进行第 ${retryCount} 次重试，等待 ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      
      console.error("Gemini Error:", error);
      
      if (error.message.includes("JSON") || error.message.includes("Unterminated")) {
        throw new Error("识别结果过长导致数据截断 (Token 溢出)。建议：1. 减少上传图片数量；2. 确保网络稳定后重试。");
      }

      if (error.message.includes("API key not valid")) {
        throw new Error("API Key 无效，请检查环境变量配置。");
      }

      if (error.message.includes("Safety")) {
        throw new Error("AI 触发了安全过滤机制，可能因为图片内容被误判。请尝试更换图片。");
      }

      if (error.message.includes("fetch failed")) {
        throw new Error("网络连接失败，请检查您的网络连接或 API 服务状态。");
      }
      
      const message = error.message || "未知错误";
      throw new Error(`AI 处理失败: ${message}`);
    }
  }

  throw lastError;
}
