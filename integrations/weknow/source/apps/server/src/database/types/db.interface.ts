import type {
  WritingActivityTable,
  WritingStatisticsMetadataTable,
} from './writing.types';
import { DB } from '@docmost/db/types/db';
import { PageEmbeddings } from '@docmost/db/types/embeddings.types';
import { FeishuIdentities } from './feishu.types';
import { Generated } from 'kysely';

export interface DbInterface extends DB {
  writingActivity: WritingActivityTable;
  writingStatisticsMetadata: WritingStatisticsMetadataTable;
  pageEmbeddings: PageEmbeddings;
  feishuIdentities: FeishuIdentities;
  pageReadingHistory: {
    userId: string;
    pageId: string;
    workspaceId: string;
    lastReadAt: Generated<Date>;
  };
}
