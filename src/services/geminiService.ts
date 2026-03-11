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

export async function processAttendanceImages(
  images: { data: string; name: string }[]
): Promise<IdentifiedPerson[]> {
  try {
    const imagesToProcess = images.slice(0, 6);

    const response = await fetch('/api/analyze-attendance', {
      method: 'POST',
      headers: {
        'Content-Type': 'application/json',
      },
      // 彻底移除 customApiKey，只向后端发送图片数据
      body: JSON.stringify({ 
        images: imagesToProcess
      })
    });

    const result = await response.json();

    if (!response.ok) {
      throw new Error(result.error || `HTTP error! status: ${response.status}`);
    }

    if (!result.success) {
      throw new Error(result.error || "后端处理失败");
    }

    return result.data;
  } catch (error: any) {
    console.error("Fetch error:", error);
    throw new Error(`${error.message || "网络请求失败，请检查后端服务是否正常运行"}`);
  }
}