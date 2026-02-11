
export interface MasterProfile {
  name: string;
  summary: string;
  skills: string[];
  experience: {
    role: string;
    company: string;
    highlights: string[];
  }[];
  hiddenStrengths: string[];
}

export interface SearchStrategy {
  priorities: string[];
  dealbreakers: string[];
  preferredIndustries: string[];
  locationPreference: 'remote' | 'hybrid' | 'onsite' | 'flexible';
  seniorityLevel: string;
}

export interface JobMatch {
  id: string;
  title: string;
  company: string;
  location: string;
  description: string;
  score: number;
  reasoning: {
    pros: string[];
    cons: string[];
    riskFactors: string[];
  };
  link: string;
  source?: string;
  status?: 'accepted' | 'dismissed' | 'pending';
}

export type AppView = 'profile' | 'strategy' | 'scanner' | 'automation' | 'history' | 'legal';
