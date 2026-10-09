# Native Example

A C plugin that logs a message when it starts and reports setting changes. Its Settings tab contains a boolean, a message field and a strength slider.

The source demonstrates a `Bedrock_GetPlugin` descriptor, reading saved settings during `start`, releasing returned values, and using the host logging function. Disabling calls `stop`; enabling it again reads the current saved message.
