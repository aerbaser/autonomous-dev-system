// Types for the development phase

export interface DevTask {
  id: string;
  title: string;
  description: string;
  estimatedComplexity: "low" | "medium" | "high";
  dependencies: string[]; // IDs of tasks this depends on
  acceptanceCriteria: string[];
  domain?: string; // agent name or role keyword for matching
  tags?: string[];
}

export interface TaskDecomposition {
  tasks: DevTask[];
}

export interface BatchResult {
  taskResults: TaskResult[];
  costUsd: number;
  sessionId?: string;
}

export interface TaskResult {
  taskId: string;
  success: boolean;
  output?: string;
  result?: string;
  error?: string;
}
