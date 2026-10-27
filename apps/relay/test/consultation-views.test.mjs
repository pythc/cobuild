import test from "node:test";
import assert from "node:assert/strict";
import {
  conversationBucket,
  filterConversations,
  selectedConversation,
  messageSender,
} from "../src/consultation-views.js";

test("ending removes the selected conversation from the inbox and retains it in ended; reopening restores it", () => {
  const active = { id: "one", state: "open" },
    next = { id: "two", state: "new" },
    closed = { id: "old", state: "resolved" };
  let rows = [active, next, closed];
  assert.deepEqual(
    conversationBucket(rows, true, "inbox").map((c) => c.id),
    ["one", "two"],
  );
  rows = rows.map((c) => (c.id === "one" ? { ...c, state: "resolved" } : c));
  assert.equal(
    selectedConversation(conversationBucket(rows, true, "inbox"), "one").id,
    "two",
  );
  assert.deepEqual(
    conversationBucket(rows, true, "ended").map((c) => c.id),
    ["one", "old"],
  );
  assert.equal(
    selectedConversation(
      conversationBucket(rows, true, "inbox").filter((c) => c.id !== "two"),
      "one",
    ),
    null,
  );
  rows = rows.map((c) => (c.id === "one" ? { ...c, state: "open" } : c));
  assert.equal(
    selectedConversation(conversationBucket(rows, true, "inbox"), "one").id,
    "one",
  );
  assert.equal(
    conversationBucket(rows, true, "ended").some((c) => c.id === "one"),
    false,
  );
  assert.equal(
    conversationBucket(rows, false, "inbox").length,
    3,
    "customer retains conversation history",
  );
});

test("customer sees the assistant name while the operator can trace real senders", () => {
  const conversation = { name: "Customer", owner: "Staff" };
  assert.equal(
    messageSender(
      { side: "operator", senderName: "Person A" },
      conversation,
      false,
    ),
    "小助手",
  );
  assert.equal(
    messageSender(
      { side: "operator", senderName: "Person B" },
      conversation,
      false,
    ),
    "小助手",
  );
  assert.equal(
    messageSender(
      { side: "customer", senderName: "Customer" },
      conversation,
      false,
    ),
    "我",
  );
  assert.equal(
    messageSender(
      { side: "operator", senderName: "Person A" },
      conversation,
      true,
    ),
    "Person A",
  );
});

test('closing a searched conversation cannot expose a different recipient outside the visible list',()=>{
  const own={id:'own',name:'Test',title:'export',app:'makit',state:'open',receptionist:{id:'me'}},other={id:'other',name:'Other',title:'billing',app:'makit',state:'open',receptionist:{id:'another'}};
  const filter=rows=>filterConversations(conversationBucket(rows,true,'inbox'),{search:'export',appName:()=> 'Makit'});
  assert.equal(selectedConversation(filter([own,other]),'own').id,'own');
  assert.equal(selectedConversation(filter([{...own,state:'resolved'},other]),'own'),null);
  assert.deepEqual(filterConversations([own,other],{queue:'mine',employeeId:'me'}).map(c=>c.id),['own']);
});
