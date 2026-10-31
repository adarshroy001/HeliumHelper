export { MessagingApiModule } from './messaging-api.module.js';
export { MessagingModule } from './messaging.module.js';
export {
  GraphClient,
  type MessageContent,
  type SendEndpoint,
  type SendResult,
} from './whatsapp/graph-client.js';
export { normalizePhone, parsePhoneList, phoneLookupVariants } from './whatsapp/phone.js';
export {
  buildTemplatePayload,
  extractTemplateVariables,
  headerMediaType,
  mappingProblem,
  quickReplyButtons,
  renderTemplate,
  resolveParams,
  type RecipientFields,
  type TemplateComponent,
  type TemplatePayload,
  type TemplateVariable,
  type VariableMapping,
} from './whatsapp/template.js';
