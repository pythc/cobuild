// A lost HTTP response is not evidence that enqueueing failed. Recover the
// frozen batch before allowing a new send; retrying uses the same request ID.
export async function enqueueFrozenMail(session, input) {
  try {
    return await session.request("direct-mail/send", {
      method: "POST",
      data: input,
    });
  } catch (error) {
    if (error.status && error.status < 500 && error.status !== 409) throw error;
    try {
      const batch = await session.request("direct-mail/" + input.id);
      if (batch.sent && batch.previewHash === input.previewHash) return batch;
      throw Object.assign(error, { enqueueUnknown: false });
    } catch (checkError) {
      if (checkError === error) throw error;
      throw Object.assign(
        Error(
          "发送请求结果尚未确认，请重试同一请求。确认前不能返回编辑，避免重复发送。",
        ),
        { enqueueUnknown: true, cause: error },
      );
    }
  }
}
