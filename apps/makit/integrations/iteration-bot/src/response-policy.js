import {
  requirementRecordUrl,
  rewriteLegacyNotificationLinks
} from "./requirement-links.js";

const REQUIREMENT_TERMS = /(需求|事项|任务|处理人|负责人|评审|产品|开发|研发|提测|测试|发布|上线|阻塞|逾期|延期)/;
const GROUP_NOTICE_TERMS = /(催办|提醒|通知|跟踪|跟进|推进|逾期|延期|阻塞|未填|未填写|缺失|反馈)/;
const FORMAL_CLOSING = "> 请相关人员尽快推进，并及时更新状态和进展。";

function uniquePeople(groups) {
  const result = [];
  const seen = new Set();
  for (const person of groups.flat()) {
    if (!person?.id || seen.has(person.id)) continue;
    seen.add(person.id);
    result.push(person);
  }
  return result;
}

function mentionList(people) {
  return people
    .map((person) => `<at user_id="${person.id}">${person.name || ""}</at>`)
    .join("、");
}

function peopleForInstruction(item, instruction) {
  const groups = [item.handlers || []];
  if (/(评审|产品|验收|体验)/.test(instruction)) groups.push(item.productOwners || []);
  if (/(开发|研发|代码|联调)/.test(instruction)) groups.push(item.developers || []);
  if (/(提测|测试|质量)/.test(instruction)) groups.push(item.testers || []);
  if (/(发布|上线|阻塞|跨阶段)/.test(instruction)) {
    groups.push(item.productOwners || [], item.developers || [], item.testers || []);
  }
  return uniquePeople(groups);
}

export { requirementRecordUrl };

export function isRequirementRelated(instruction) {
  return REQUIREMENT_TERMS.test(String(instruction || ""));
}

export function decorateRequirementResponse(response, instruction, requirements, config) {
  let lines = rewriteLegacyNotificationLinks(response, config).split("\n");
  if (!isRequirementRelated(instruction) || !requirements?.length) return lines.join("\n");

  const decorated = new Set();
  lines = lines.map((line) => {
    let result = line;
    const matched = requirements.filter((candidate) =>
      !decorated.has(candidate.recordId)
      && candidate.title
      && result.includes(candidate.title)
    );
    for (const item of matched) {
      decorated.add(item.recordId);
      const link = requirementRecordUrl(config, item.recordId);
      if (!result.includes(link)) {
        const markdownLinkStart = result.indexOf(`[${item.title}](`);
        const markdownLinkEnd = markdownLinkStart >= 0
          ? result.indexOf(")", markdownLinkStart + item.title.length + 3)
          : -1;
        if (markdownLinkStart >= 0 && markdownLinkEnd >= 0) {
          result = `${result.slice(0, markdownLinkStart)}[${item.title}](${link})${result.slice(markdownLinkEnd + 1)}`;
        } else {
          result = result.replace(item.title, `[${item.title}](${link})`);
        }
      }

      const people = peopleForInstruction(item, String(instruction || ""));
      const missingMentions = people.filter((person) =>
        !result.includes(`<at user_id="${person.id}">`)
      );
      if (missingMentions.length) result += ` · ${mentionList(missingMentions)}`;
      if (!(item.handlers || []).length && !result.includes("未分配处理人")) {
        result += " · 未分配处理人";
      }
    }
    return result;
  });
  return lines.join("\n");
}

export function appendFormalGroupClosing(response, instruction, chatType) {
  const text = String(response || "").trim();
  if (
    chatType !== "group"
    || !GROUP_NOTICE_TERMS.test(String(instruction || ""))
    || text.includes("请相关人员尽快推进")
  ) {
    return text;
  }
  return `${text}\n\n${FORMAL_CLOSING}`;
}

export function enforceResponsePolicy(response, instruction, requirements, config, chatType) {
  const decorated = decorateRequirementResponse(response, instruction, requirements, config);
  return rewriteLegacyNotificationLinks(
    appendFormalGroupClosing(decorated, instruction, chatType),
    config
  );
}

export { FORMAL_CLOSING };
