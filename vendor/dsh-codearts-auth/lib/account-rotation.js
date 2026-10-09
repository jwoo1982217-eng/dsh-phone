import { AsyncLocalStorage } from 'node:async_hooks';
const requests = new AsyncLocalStorage();
export function rotationRequest(provider) {
    const request = requests.getStore();
    return request?.provider === provider ? request : undefined;
}
/** 在迭代器的每一步恢复上下文，覆盖准备后的 stream、异常与取消清理。 */
export function rotatingStream(provider, model, create, signal) {
    return {
        [Symbol.asyncIterator]() {
            const request = rotationRequest(provider) ?? { provider, model, signal, accounts: new Map() };
            const iterator = requests.run(request, () => create()[Symbol.asyncIterator]());
            return {
                next: () => requests.run(request, () => { signal?.throwIfAborted(); return iterator.next(); }),
                return: (value) => requests.run(request, () => iterator.return
                    ? iterator.return(value) : Promise.resolve({ done: true, value: value })),
                throw: (error) => requests.run(request, () => iterator.throw
                    ? iterator.throw(error) : Promise.reject(error)),
            };
        },
    };
}
/** 按稳定 ID 续接用户排列；已删除的上次账号不参与，新增账号自然进入环。 */
export function afterAccount(accounts, last) {
    const index = accounts.findIndex(account => account.id === last);
    if (index < 0)
        return [...accounts];
    return [...accounts.slice(index + 1), ...accounts.slice(0, index + 1)];
}
//# sourceMappingURL=account-rotation.js.map