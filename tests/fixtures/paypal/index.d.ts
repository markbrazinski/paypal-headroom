/** Sanitized REPLAY fixture: {status, body}. A fresh deep copy each call so tests can alter it. */
export declare function fixture<T = any>(name: string): {
    status: number;
    body: T;
};
