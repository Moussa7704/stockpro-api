// Importer ce fichier enregistre tous les modèles auprès de Sequelize
import { EmailOtpCode } from "./email-otp-code.model.js";
import { RefreshToken } from "./refresh-token.model.js";
import { User } from "./user.model.js";

// Associations : supprimer un utilisateur supprime ses sessions et ses codes OTP
User.hasMany(RefreshToken, { foreignKey: "userId", onDelete: "CASCADE" });
RefreshToken.belongsTo(User, { foreignKey: "userId" });

User.hasMany(EmailOtpCode, { foreignKey: "userId", onDelete: "CASCADE" });
EmailOtpCode.belongsTo(User, { foreignKey: "userId" });

export { EmailOtpCode, RefreshToken, User };
