import pandas as pd
import numpy as np
import tensorflow as tf
from tensorflow import keras

print("Loading CSV dataset...")

data = pd.read_csv("/app/1774935415436-data.csv")

# Separate features and labels
X = data.iloc[:, :-1].values
y = data.iloc[:, -1].values

# Reshape to image format (32x32x3)
X = X.reshape(-1, 32, 32, 3)

# Normalize
X = X / 255.0

# Split manually
split = int(0.8 * len(X))
X_train, X_test = X[:split], X[split:]
y_train, y_test = y[:split], y[split:]

print("Dataset ready!")

# Simple CNN
model = keras.Sequential([
    keras.layers.Conv2D(32, (3,3), activation='relu', input_shape=(32,32,3)),
    keras.layers.MaxPooling2D((2,2)),

    keras.layers.Conv2D(64, (3,3), activation='relu'),
    keras.layers.MaxPooling2D((2,2)),

    keras.layers.Flatten(),
    keras.layers.Dense(128, activation='relu'),
    keras.layers.Dense(10, activation='softmax')
])

model.compile(
    optimizer='adam',
    loss='sparse_categorical_crossentropy',
    metrics=['accuracy']
)

print("\nTraining...\n")

model.fit(X_train, y_train, epochs=10, batch_size=64)

print("\nEvaluating...\n")

loss, acc = model.evaluate(X_test, y_test)

print(f"\nAccuracy: {acc:.4f}")
print(f"Loss: {loss:.4f}")
