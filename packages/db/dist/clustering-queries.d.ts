export declare function generateFundingClusters(): Promise<void>;
export declare function generateBehavioralClusters(): Promise<void>;
export declare function updateClusterPerformance(clusterId: string): Promise<void>;
export declare function listClusters(): Promise<import("pg").QueryResultRow[]>;
export declare function getClusterWithMembers(clusterId: string): Promise<{
    cluster: {
        id: string;
        name: string;
        confidence: number;
    };
    members: import("pg").QueryResultRow[];
} | null>;
//# sourceMappingURL=clustering-queries.d.ts.map