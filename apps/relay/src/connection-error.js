// Recovery follows the HTTP contract, never words in a translated message.
export function connectionFailure(error, embedded = false) {
  const login = error?.status === 401;
  return {
    action: login ? "login" : "retry",
    label: login ? (embedded ? "重新连接" : "重新登录") : "重新连接",
    message:
      login && !embedded
        ? "登录已失效，请重新登录"
        : error?.message || "服务暂时无法连接，请重试",
  };
}
