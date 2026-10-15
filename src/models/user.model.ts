import bcrypt from "bcryptjs";
import {
  DataTypes,
  Model,
  type CreationOptional,
  type InferAttributes,
  type InferCreationAttributes,
} from "sequelize";
import { sequelize } from "../config/database.js";

export const USER_ROLES = ["admin", "manager", "employee"] as const;
export type UserRole = (typeof USER_ROLES)[number];

const SALT_ROUNDS = 12;

export class User extends Model<InferAttributes<User>, InferCreationAttributes<User>> {
  declare id: CreationOptional<string>;
  declare name: string;
  declare email: string;
  // null tant que l'utilisateur invité n'a pas défini son mot de passe
  declare password: CreationOptional<string | null>;
  declare role: CreationOptional<UserRole>;
  declare createdAt: CreationOptional<Date>;
  declare updatedAt: CreationOptional<Date>;

  async comparePassword(plainPassword: string): Promise<boolean> {
    // Compte invité sans mot de passe : aucune connexion possible
    if (!this.password) {
      return false;
    }
    return bcrypt.compare(plainPassword, this.password);
  }

  // Ne jamais renvoyer le hash du mot de passe dans une réponse JSON
  override toJSON() {
    const { password, ...rest } = this.get();
    // Indique seulement si l'invitation est encore en attente (mot de passe pas encore défini)
    return { ...rest, invitationPending: password === null };
  }
}

User.init(
  {
    id: {
      type: DataTypes.UUID,
      defaultValue: DataTypes.UUIDV4,
      primaryKey: true,
    },
    name: {
      type: DataTypes.STRING(100),
      allowNull: false,
    },
    email: {
      type: DataTypes.STRING(255),
      allowNull: false,
      unique: true,
      validate: { isEmail: true },
      // "Jean@Mail.com " et "jean@mail.com" doivent être le même compte
      set(value: string) {
        this.setDataValue("email", value.trim().toLowerCase());
      },
    },
    password: {
      type: DataTypes.STRING,
      allowNull: true,
      defaultValue: null,
    },
    role: {
      type: DataTypes.ENUM(...USER_ROLES),
      allowNull: false,
      defaultValue: "employee",
    },
    createdAt: DataTypes.DATE,
    updatedAt: DataTypes.DATE,
  },
  {
    sequelize,
    tableName: "users",
    hooks: {
      // Appelé avant chaque create() et save() : on ne hash que si le mot de passe a changé
      beforeSave: async (user) => {
        if (user.changed("password") && user.password) {
          user.password = await bcrypt.hash(user.password, SALT_ROUNDS);
        }
      },
    },
  },
);
