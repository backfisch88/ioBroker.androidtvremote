import ioBrokerConfig from "@iobroker/eslint-config";

export default [
    ...ioBrokerConfig,
    {
        ignores: [
            "node_modules/**",
            "coverage/**"
        ]
    }
];
