import { Injectable, Logger } from '@nestjs/common';
import { Hocuspocus, Document } from '@hocuspocus/server';
import { TiptapTransformer } from '@hocuspocus/transformer';
import {
  prosemirrorNodeToYElement,
  tiptapExtensions,
} from './collaboration.util';
import { setYjsMark, updateYjsMarkAttribute, YjsSelection } from './yjs.util';
import * as Y from 'yjs';
import { EnvironmentService } from '../integrations/environment/environment.service';
import { reviewSelection, applyReview } from '../core/review/review-yjs';
import { User } from '@docmost/db/types/entity.types';
import {
  applyLivePatches,
  liveContent,
  revision,
} from '../core/knowledge/knowledge-blocks';

export type CollabEventHandlers = ReturnType<
  CollaborationHandler['getHandlers']
>;

@Injectable()
export class CollaborationHandler {
  private readonly logger = new Logger(CollaborationHandler.name);

  constructor(private readonly environment: EnvironmentService) {}

  getHandlers(hocuspocus: Hocuspocus) {
    return {
      reviewRead: async (
        name: string,
        payload: { user: User; selection: any },
      ) => {
        const c = await hocuspocus.openDirectConnection(name, {
          user: payload.user,
          knowledgeReadOnly: true,
        });
        try {
          const v = reviewSelection(c.document, payload.selection);
          return { original: v.text, fingerprint: v.fingerprint };
        } catch (e: any) {
          return { error: e.getStatus?.() || 400, message: e.message };
        } finally {
          await c.disconnect();
        }
      },
      reviewApply: async (
        name: string,
        payload: { user: User; suggestion: any },
      ) => {
        try {
          let receipt: any;
          let stateVector: string;
          await this.withYdocConnection(
            hocuspocus,
            name,
            { user: payload.user, knowledgeDurable: true },
            (doc) => {
              receipt = applyReview(
                doc,
                { ...payload.suggestion, actorId: payload.user.id },
                this.environment.getAppSecret(),
              );
              stateVector = Buffer.from(Y.encodeStateVector(doc)).toString(
                'base64',
              );
            },
          );
          return { receipt, stateVector };
        } catch (e: any) {
          return {
            error: e.getStatus?.() || 503,
            message: e.getStatus ? e.message : '保存未确认，请重试同一建议',
          };
        }
      },
      knowledgeCheckpoint: async (
        documentName: string,
        payload: { user: User },
      ) => {
        const connection = await hocuspocus.openDirectConnection(documentName, {
          user: payload.user,
          knowledgeReadOnly: true,
          knowledgeDurable: true,
        });
        try {
          return {
            stateVector: Buffer.from(
              Y.encodeStateVector(connection.document),
            ).toString('base64'),
          };
        } finally {
          await connection.disconnect();
        }
      },
      knowledgeRead: async (documentName: string, payload: { user: User }) => {
        const loaded = hocuspocus.documents.get(documentName);
        if (loaded) {
          const content = liveContent(loaded);
          return { content, revision: revision(content) };
        }
        const connection = await hocuspocus.openDirectConnection(documentName, {
          user: payload.user,
          knowledgeReadOnly: true,
        });
        try {
          const doc = connection.document;
          const content = liveContent(doc);
          return { content, revision: revision(content) };
        } finally {
          await connection.disconnect();
        }
      },
      knowledgePatch: async (
        documentName: string,
        payload: { user: User; expectedRevision: string; patches: any[] },
      ) => {
        // Return structured failures across Redis, which cannot serialize HttpException objects.
        try {
          let result: any;
          const context = {
            user: payload.user,
            knowledgeDurable: true,
            knowledgeReadOnly: false,
          };
          await this.withYdocConnection(
            hocuspocus,
            documentName,
            context,
            (doc) => {
              result = applyLivePatches(
                doc,
                payload.expectedRevision,
                payload.patches,
              );
              context.knowledgeReadOnly =
                result.revision === payload.expectedRevision;
              result.stateVector = Buffer.from(
                Y.encodeStateVector(doc),
              ).toString('base64');
            },
          );
          return result;
        } catch (error: any) {
          return {
            error:
              typeof error.getStatus === 'function' ? error.getStatus() : 503,
            message:
              typeof error.getStatus === 'function'
                ? error.message
                : 'Document write could not be confirmed',
          };
        }
      },
      alterState: async (documentName: string, payload: { pageId: string }) => {
        // dummy
        // this.logger.log('Processing', documentName, payload);
        // await this.withYdocConnection(hocuspocus, documentName, {}, (doc) => {
        //   const fragment = doc.getXmlFragment('default');
        //});
      },
      setCommentMark: async (
        documentName: string,
        payload: {
          yjsSelection: YjsSelection;
          commentId: string;
          resolved: boolean;
          user: User;
        },
      ) => {
        const { yjsSelection, commentId, resolved, user } = payload;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            setYjsMark(doc, fragment, yjsSelection, 'comment', {
              commentId,
              resolved,
            });
          },
        );
      },
      resolveCommentMark: async (
        documentName: string,
        payload: {
          commentId: string;
          resolved: boolean;
          user: User;
        },
      ) => {
        const { commentId, resolved, user } = payload;
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');
            updateYjsMarkAttribute(
              fragment,
              'comment',
              { name: 'commentId', value: commentId },
              { resolved },
            );
          },
        );
      },
      updatePageContent: async (
        documentName: string,
        payload: {
          prosemirrorJson: any;
          operation: string;
          user: User;
        },
      ) => {
        const { prosemirrorJson, operation, user } = payload;
        this.logger.debug('Updating page content via yjs', documentName);
        await this.withYdocConnection(
          hocuspocus,
          documentName,
          { user },
          (doc) => {
            const fragment = doc.getXmlFragment('default');

            if (operation === 'replace') {
              if (fragment.length > 0) {
                fragment.delete(0, fragment.length);
              }

              const newDoc = TiptapTransformer.toYdoc(
                prosemirrorJson,
                'default',
                tiptapExtensions,
              );
              Y.applyUpdate(doc, Y.encodeStateAsUpdate(newDoc));
            } else {
              const newContent = prosemirrorJson.content || [];
              const yElements = newContent.map(prosemirrorNodeToYElement);
              const position = operation === 'prepend' ? 0 : fragment.length;
              fragment.insert(position, yElements);
            }
          },
        );
      },
    };
  }

  async withYdocConnection(
    hocuspocus: Hocuspocus,
    documentName: string,
    context: any = {},
    fn: (doc: Document) => void,
  ): Promise<void> {
    const connection = await hocuspocus.openDirectConnection(
      documentName,
      context,
    );
    try {
      await connection.transact(fn);
    } finally {
      await connection.disconnect();
    }
  }
}
