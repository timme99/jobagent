
import { GoogleGenAI, Type } from "@google/genai";
import { MasterProfile, SearchStrategy, JobMatch } from "./types";

// Always use named parameter for apiKey and obtain it directly from process.env.API_KEY
const ai = new GoogleGenAI({ apiKey: process.env.API_KEY });

/**
 * Utility to handle API retries with exponential backoff for 429 errors.
 */
async function withRetry<T>(fn: () => Promise<T>, maxRetries = 3): Promise<T> {
  let lastError: any;
  for (let i = 0; i < maxRetries; i++) {
    try {
      return await fn();
    } catch (error: any) {
      lastError = error;
      const isRateLimit = error?.message?.includes('429') || error?.status === 429;
      if (isRateLimit && i < maxRetries - 1) {
        const delay = Math.pow(2, i) * 2000; // 2s, 4s, 8s...
        console.warn(`Rate limit hit. Retrying in ${delay}ms...`);
        await new Promise(resolve => setTimeout(resolve, delay));
        continue;
      }
      throw error;
    }
  }
  throw lastError;
}

export const synthesizeProfile = async (
  profileUrl?: string,
  cvText?: string,
  extraInfo?: string
): Promise<{ profile: MasterProfile, sources: any[] }> => {
  return withRetry(async () => {
    let prompt = "Synthesize a high-fidelity Master Profile from the following professional data sources. Identify trajectory trends and 'hidden strengths'.\n\n";

    if (profileUrl) prompt += `1. LinkedIn Profile URL to scan: ${profileUrl}\n`;
    if (cvText) prompt += `2. CV/Professional History Text:\n${cvText}\n\n`;
    if (extraInfo) prompt += `3. Additional Context & Preferences to consider:\n${extraInfo}\n\n`;

    prompt += "Ensure the output strictly follows the provided JSON schema. Combine all information into a single unified profile.";

    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash', // Fast and capable for synthesis
      contents: prompt,
      config: {
        tools: profileUrl ? [{ googleSearch: {} }] : [],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            name: { type: Type.STRING },
            summary: { type: Type.STRING },
            skills: { type: Type.ARRAY, items: { type: Type.STRING } },
            experience: {
              type: Type.ARRAY,
              items: {
                type: Type.OBJECT,
                properties: {
                  role: { type: Type.STRING },
                  company: { type: Type.STRING },
                  highlights: { type: Type.ARRAY, items: { type: Type.STRING } }
                },
                required: ["role", "company", "highlights"]
              }
            },
            hiddenStrengths: { type: Type.ARRAY, items: { type: Type.STRING } }
          },
          required: ["name", "summary", "skills", "experience", "hiddenStrengths"]
        }
      }
    });

    const groundingChunks = response.candidates?.[0]?.groundingMetadata?.groundingChunks || [];
    const parsed = JSON.parse(response.text || '{}');
    const profile: MasterProfile = {
      name: parsed.name || 'Unknown',
      summary: parsed.summary || '',
      skills: Array.isArray(parsed.skills) ? parsed.skills : [],
      experience: Array.isArray(parsed.experience) ? parsed.experience : [],
      hiddenStrengths: Array.isArray(parsed.hiddenStrengths) ? parsed.hiddenStrengths : []
    };
    return { profile, sources: groundingChunks };
  });
};

const VALID_LOCATION_PREFERENCES = ['remote', 'hybrid', 'onsite', 'flexible'] as const;

export const refineStrategy = async (messyThoughts: string): Promise<SearchStrategy> => {
  return withRetry(async () => {
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: `Convert these unstructured career preferences and "messy thoughts" into a rigorous Search Strategy: ${messyThoughts}`,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            priorities: { type: Type.ARRAY, items: { type: Type.STRING } },
            dealbreakers: { type: Type.ARRAY, items: { type: Type.STRING } },
            preferredIndustries: { type: Type.ARRAY, items: { type: Type.STRING } },
            locationPreference: { type: Type.STRING, enum: ["remote", "hybrid", "onsite", "flexible"] },
            seniorityLevel: { type: Type.STRING }
          },
          required: ["priorities", "dealbreakers", "preferredIndustries", "locationPreference", "seniorityLevel"]
        }
      }
    });
    const parsed = JSON.parse(response.text || '{}');
    const locationRaw = (parsed.locationPreference || 'flexible').toLowerCase();
    const locationPreference = VALID_LOCATION_PREFERENCES.includes(locationRaw as any)
      ? (locationRaw as SearchStrategy['locationPreference'])
      : 'flexible';
    return {
      priorities: Array.isArray(parsed.priorities) ? parsed.priorities : [],
      dealbreakers: Array.isArray(parsed.dealbreakers) ? parsed.dealbreakers : [],
      preferredIndustries: Array.isArray(parsed.preferredIndustries) ? parsed.preferredIndustries : [],
      locationPreference,
      seniorityLevel: parsed.seniorityLevel || 'mid-level'
    };
  });
};

export const scoreJobMatch = async (
  profile: MasterProfile,
  strategy: SearchStrategy,
  jobData: Partial<JobMatch> & { description?: string }
): Promise<JobMatch> => {
  return withRetry(async () => {
    const description = jobData.description || 'No description provided';
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: `
        Act as an expert technical recruiter. Cross-reference this Profile and Search Strategy against the Job Description.

        ### PROFILE
        ${JSON.stringify(profile)}

        ### STRATEGIC RULES
        ${JSON.stringify(strategy)}

        ### JOB DESCRIPTION
        ${description}

        Score the match 0-100. Provide nuanced reasoning including risk factors.
      `,
      config: {
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.OBJECT,
          properties: {
            score: { type: Type.NUMBER },
            reasoning: {
              type: Type.OBJECT,
              properties: {
                pros: { type: Type.ARRAY, items: { type: Type.STRING } },
                cons: { type: Type.ARRAY, items: { type: Type.STRING } },
                riskFactors: { type: Type.ARRAY, items: { type: Type.STRING } }
              },
              required: ["pros", "cons", "riskFactors"]
            }
          },
          required: ["score", "reasoning"]
        }
      }
    });

    const analysis = JSON.parse(response.text || '{}');
    return {
      id: jobData.id || Math.random().toString(36).substr(2, 9),
      title: jobData.title || 'Untitled Position',
      company: jobData.company || 'Unknown Company',
      location: jobData.location || 'Not specified',
      description,
      link: jobData.link || '#',
      score: typeof analysis.score === 'number' ? analysis.score : 0,
      reasoning: {
        pros: Array.isArray(analysis.reasoning?.pros) ? analysis.reasoning.pros : [],
        cons: Array.isArray(analysis.reasoning?.cons) ? analysis.reasoning.cons : [],
        riskFactors: Array.isArray(analysis.reasoning?.riskFactors) ? analysis.reasoning.riskFactors : []
      },
      status: 'pending'
    };
  });
};

export const fetchLiveJobs = async (keywords: string, location: string): Promise<any[]> => {
  return withRetry(async () => {
    // We use googleSearch tool here to find REAL LinkedIn job postings.
    // Switching to Pro for better search grounding accuracy.
    const response = await ai.models.generateContent({
      model: 'gemini-2.0-flash',
      contents: `Search for real, currently active LinkedIn job postings for keywords: "${keywords}" in location: "${location}". 
                 You must find 5 authentic jobs. Extract their REAL URLs, job titles, company names, and full descriptions.
                 Return them as a JSON array of objects. Do not hallucinate URLs; only use valid links found during the search.`,
      config: {
        tools: [{ googleSearch: {} }],
        responseMimeType: "application/json",
        responseSchema: {
          type: Type.ARRAY,
          items: {
            type: Type.OBJECT,
            properties: {
              id: { type: Type.STRING },
              title: { type: Type.STRING },
              company: { type: Type.STRING },
              location: { type: Type.STRING },
              link: { type: Type.STRING, description: "The REAL, actual URL to the LinkedIn job posting found on the web." },
              description: { type: Type.STRING }
            },
            required: ["id", "title", "company", "location", "link", "description"]
          }
        }
      }
    });

    try {
      // Clean the response text in case grounding metadata or formatting marks are included
      const rawText = response.text ?? '';
      let jsonStr = rawText.trim();
      if (jsonStr.startsWith('```json')) {
        jsonStr = jsonStr.replace(/^```json\n?/, '').replace(/\n?```$/, '');
      }
      if (!jsonStr) {
        console.warn("fetchLiveJobs: Empty response from API");
        return [];
      }
      const parsed = JSON.parse(jsonStr);
      return Array.isArray(parsed) ? parsed : [];
    } catch (e) {
      console.error("JSON Parse Error in fetchLiveJobs:", e);
      // Return an empty array if parsing fails to avoid crashing the app
      return [];
    }
  });
};
