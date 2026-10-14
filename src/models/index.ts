// Importer ce fichier enregistre tous les modèles auprès de Sequelize
import { RefreshToken } from "./refresh-token.model.js";
import { TwoFactorBackupCode } from "./two-factor-backup-code.model.js";
import { User } from "./user.model.js";
import { UserTwoFactor } from "./user-two-factor.model.js";

// Associations : supprimer un utilisateur supprime ses sessions et sa configuration 2FA
User.hasMany(RefreshToken, { foreignKey: "userId", onDelete: "CASCADE" });
RefreshToken.belongsTo(User, { foreignKey: "userId" });

User.hasOne(UserTwoFactor, { foreignKey: "userId", onDelete: "CASCADE" });
UserTwoFactor.belongsTo(User, { foreignKey: "userId" });

User.hasMany(TwoFactorBackupCode, { foreignKey: "userId", onDelete: "CASCADE" });
TwoFactorBackupCode.belongsTo(User, { foreignKey: "userId" });

export { RefreshToken, TwoFactorBackupCode, User, UserTwoFactor };
