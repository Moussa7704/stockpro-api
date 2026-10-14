// Importer ce fichier enregistre tous les modèles auprès de Sequelize
import { RefreshToken } from "./refresh-token.model.js";
import { User } from "./user.model.js";

// Associations : supprimer un utilisateur supprime ses sessions
User.hasMany(RefreshToken, { foreignKey: "userId", onDelete: "CASCADE" });
RefreshToken.belongsTo(User, { foreignKey: "userId" });

export { RefreshToken, User };
